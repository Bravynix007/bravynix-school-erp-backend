import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { newId } from '../../common/ids/ids.js';
import { fieldError } from '../../common/validation/field-error.js';
import { AuditService, type AuditValues } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { ScopeService, type InstitutionContext } from '../../platform/tenancy/index.js';
import {
  AcademicYearDirectory,
  SectionDirectory,
  SubjectDirectory,
  TeachingStaff,
} from '../academic-setup/index.js';
import { TimeSlotRepository } from './time-slot.repository.js';
import type {
  CreateTimetableEntryDto,
  ListTimetableQueryDto,
  UpdateTimetableEntryDto,
} from './timetable-entry.dto.js';
import {
  TimetableEntryRepository,
  type TimetableEntryChanges,
  type TimetableEntryRow,
  type TimetableEntryWithSlot,
} from './timetable-entry.repository.js';
import {
  timetableEntryResource,
  type EntryNames,
  type TimetableEntryResource,
} from './timetable-entry.resource.js';
import {
  requireEntryShape,
  requireUsableSlot,
  translateEntryError,
  type EntryShape,
} from './timetable-entry.rules.js';
import { TimetableChildren } from './timetable-children.js';
import { TimetableStaff } from './timetable-staff.js';

/** What the audit log keeps of an entry. */
function auditView(row: TimetableEntryRow): AuditValues {
  return {
    section_id: row.section_id,
    day_of_week: row.day_of_week,
    time_slot_id: row.time_slot_id,
    is_break: row.is_break,
    subject_id: row.subject_id,
    staff_member_id: row.staff_member_id,
    status: row.status,
  };
}

/** The place an entry takes, for the clash rules. */
interface Placement extends EntryShape {
  sectionId: string;
  dayOfWeek: number;
  timeSlotId: string;
}

/** What a read is about, and whose tenant it runs in. */
interface Target {
  context: InstitutionContext;
  /** A parent's child, whose section is found inside the transaction. */
  studentId?: string;
  sectionId?: string;
  staffMemberId?: string;
}

/**
 * TT-01 to TT-04 (API design 9.7, 12.6): the weekly class timetable of the Institution's current year. A Society Owner
 * and an Institution Admin add, change and remove; a teacher reads their own week and the weeks of their sections, a
 * parent the week of their child's section. Every write checks the clash rules in their order, and the unique indexes
 * have the last word when two saves race.
 */
@Injectable()
export class TimetableEntryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly entries: TimetableEntryRepository,
    private readonly slots: TimeSlotRepository,
    private readonly scope: ScopeService,
    private readonly years: AcademicYearDirectory,
    private readonly sections: SectionDirectory,
    private readonly subjects: SubjectDirectory,
    private readonly teaching: TeachingStaff,
    private readonly staff: TimetableStaff,
    private readonly children: TimetableChildren,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /**
   * TT-01: the active entries of a week in the Institution's current year (422 `CURRENT_YEAR_REQUIRED` when it has
   * none), by day and period: a section's, a teacher's own at an Institution (`staffMemberId` is `me` or their ID), or a
   * parent's child's section. A teacher reads only a section they lead or teach (403 `NOT_ASSIGNED`).
   */
  async list(
    principal: Principal,
    query: ListTimetableQueryDto,
  ): Promise<ApiResult<TimetableEntryResource[]>> {
    const parent = principal.roleCode === RoleCode.StudentParent;
    const target = await this.target(principal, query);
    const { rows, names } = await this.database.transaction(target.context.tenant, async (tx) => {
      const academicYearId = await this.years.requireCurrentId(tx, target.context.institutionId);
      const filter = await this.filter(tx, principal, target);
      const found =
        filter === null ? [] : await this.entries.withSlots(tx, { academicYearId, ...filter });
      return { rows: found, names: await this.namesOf(tx, found, parent) };
    });
    return ApiResult.list(await this.resources(rows, names), null);
  }

  /**
   * TT-02: a lesson or a break in a section's day and period. 400 `INVALID_SLOT` (the period is not of the current
   * year, or is a break and the entry is not), 400 `REQUIRED` and `FIELD_NOT_ALLOWED` on the subject and the teacher,
   * 404 and 422 for a subject or teacher that is not usable, 409 `SECTION_SLOT_TAKEN` and `TEACHER_DOUBLE_BOOKED`.
   */
  async create(
    principal: Principal,
    body: CreateTimetableEntryDto,
  ): Promise<TimetableEntryResource> {
    const placement: Placement = {
      sectionId: body.sectionId,
      dayOfWeek: body.dayOfWeek,
      timeSlotId: body.timeSlotId,
      isBreak: body.isBreak ?? false,
      subjectId: body.subjectId ?? null,
      staffMemberId: body.staffMemberId ?? null,
    };
    requireEntryShape(placement);
    const context = await this.contextOfSection(principal, body.sectionId);
    const { rows, names } = await this.database
      .transaction(context.tenant, async (tx) => {
        await this.sections.requireActive(tx, body.sectionId, 'sectionId');
        const yearId = await this.years.requireCurrentId(tx, context.institutionId);
        await this.checkClashes(tx, context.institutionId, yearId, placement);
        const created = await this.entries.insert(tx, {
          id: newId(),
          society_id: context.societyId,
          institution_id: context.institutionId,
          academic_year_id: yearId,
          section_id: placement.sectionId,
          day_of_week: placement.dayOfWeek,
          time_slot_id: placement.timeSlotId,
          is_break: placement.isBreak,
          subject_id: placement.subjectId,
          staff_member_id: placement.staffMemberId,
          ...insertStamp(principal.personId),
        });
        await this.record(tx, 'timetable_entry.created', created, { after: auditView(created) });
        return this.shown(tx, created.id);
      })
      .catch((error: unknown) => {
        throw translateEntryError(error);
      });
    return this.one(rows, names);
  }

  /**
   * TT-03: any of the day, the period, whether it is a break, the subject and the teacher; the same refusals as TT-02,
   * checked on the entry as it would be. Making it a break clears the subject and the teacher. A request that changes
   * nothing writes nothing; a removed entry is 404.
   */
  async update(
    principal: Principal,
    id: string,
    body: UpdateTimetableEntryDto,
  ): Promise<TimetableEntryResource> {
    const context = await this.contextOfEntry(principal, id);
    const { rows, names } = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const isBreak = body.isBreak ?? current.is_break;
        const wanted: Placement = {
          sectionId: current.section_id,
          dayOfWeek: body.dayOfWeek ?? current.day_of_week,
          timeSlotId: body.timeSlotId ?? current.time_slot_id,
          isBreak,
          subjectId: isBreak ? (body.subjectId ?? null) : (body.subjectId ?? current.subject_id),
          staffMemberId: isBreak
            ? (body.staffMemberId ?? null)
            : (body.staffMemberId ?? current.staff_member_id),
        };
        const changes = changedColumns(current, {
          day_of_week: wanted.dayOfWeek,
          time_slot_id: wanted.timeSlotId,
          is_break: wanted.isBreak,
          subject_id: wanted.subjectId,
          staff_member_id: wanted.staffMemberId,
        }) as TimetableEntryChanges;
        if (Object.keys(changes).length === 0) return this.shown(tx, id);
        requireEntryShape(wanted);
        const yearId = await this.years.requireCurrentId(tx, context.institutionId);
        await this.checkClashes(tx, context.institutionId, yearId, wanted, id);
        const updated = await this.entries.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        await this.record(tx, 'timetable_entry.updated', updated, {
          before: auditView(current),
          after: auditView(updated),
        });
        return this.shown(tx, id);
      })
      .catch((error: unknown) => {
        throw translateEntryError(error);
      });
    return this.one(rows, names);
  }

  /** TT-04: removes the entry: `status` 0, and its day and period are free again. Nothing is deleted. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOfEntry(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const updated = await this.entries.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'timetable_entry.deactivated', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /**
   * Whose week a read is for. A parent names their child (400 `REQUIRED` without) and nothing else. Everyone else names
   * a section, or a teacher with an Institution, and has no child to name.
   */
  private async target(principal: Principal, query: ListTimetableQueryDto): Promise<Target> {
    if (principal.roleCode === RoleCode.StudentParent) {
      const errors = [
        ...(query.studentId === undefined
          ? [fieldError('studentId', FieldErrorCode.REQUIRED)]
          : []),
        ...(['sectionId', 'staffMemberId', 'institutionId'] as const)
          .filter((field) => query[field] !== undefined)
          .map((field) => fieldError(field, FieldErrorCode.FIELD_NOT_ALLOWED)),
      ];
      if (errors.length > 0) throw AppException.validation(errors);
      const studentId = query.studentId!;
      return { context: await this.children.childContext(principal, studentId), studentId };
    }
    const errors = [
      ...(query.studentId === undefined
        ? []
        : [fieldError('studentId', FieldErrorCode.FIELD_NOT_ALLOWED)]),
      ...(query.sectionId === undefined && query.staffMemberId === undefined
        ? [fieldError('sectionId', FieldErrorCode.REQUIRED)]
        : []),
      ...(query.sectionId !== undefined && query.staffMemberId !== undefined
        ? [fieldError('staffMemberId', FieldErrorCode.FIELD_NOT_ALLOWED)]
        : []),
      ...(query.staffMemberId !== undefined && query.institutionId === undefined
        ? [fieldError('institutionId', FieldErrorCode.REQUIRED)]
        : []),
      ...(query.sectionId !== undefined && query.institutionId !== undefined
        ? [fieldError('institutionId', FieldErrorCode.FIELD_NOT_ALLOWED)]
        : []),
    ];
    if (errors.length > 0) throw AppException.validation(errors);
    if (query.sectionId !== undefined) {
      return {
        context: await this.contextOfSection(principal, query.sectionId),
        sectionId: query.sectionId,
      };
    }
    return {
      context: await this.scope.requireInstitution(principal, query.institutionId!),
      staffMemberId: query.staffMemberId,
    };
  }

  /**
   * What to read for the target, inside its transaction: the section (a parent's child's, or a teacher's own, 403
   * `NOT_ASSIGNED` for any other of a teacher), or the teacher. `null` for a child who sits in no section.
   */
  private async filter(
    tx: Tx,
    principal: Principal,
    target: Target,
  ): Promise<{ sectionId: string } | { staffMemberId: string } | null> {
    if (target.studentId !== undefined) {
      const sectionId = await this.children.currentSectionId(tx, target.studentId);
      return sectionId === undefined ? null : { sectionId };
    }
    const teacher = principal.roleCode === RoleCode.TeacherStaff;
    if (target.sectionId !== undefined) {
      if (teacher) {
        const own = await this.teaching.ownSectionIds(
          tx,
          principal.personId,
          target.context.institutionId,
        );
        if (!own.has(target.sectionId)) throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
      }
      return { sectionId: target.sectionId };
    }
    const own = await this.staff.ownRecord(tx, principal.personId);
    if (target.staffMemberId === 'me') {
      if (!own) throw AppException.notFound();
      return { staffMemberId: own.staffMemberId };
    }
    if (teacher && own?.staffMemberId !== target.staffMemberId) {
      throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
    }
    return { staffMemberId: target.staffMemberId! };
  }

  /**
   * The clash rules in their order (API design 12.6), after the shape of the entry has been checked: the period, then
   * the subject and the teacher, then the section's own slot and the teacher's. `exceptId` is the entry being changed.
   */
  private async checkClashes(
    tx: Tx,
    institutionId: string,
    yearId: string,
    entry: Placement,
    exceptId?: string,
  ): Promise<void> {
    const slot = await this.slots.find(tx, entry.timeSlotId);
    if (!slot || slot.status === 0) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_SLOT);
    }
    requireUsableSlot(
      {
        institutionId: slot.institution_id,
        academicYearId: slot.academic_year_id,
        isBreak: slot.is_break,
      },
      institutionId,
      yearId,
      entry.isBreak,
    );
    if (entry.subjectId !== null && entry.staffMemberId !== null) {
      await this.subjects.requireActive(tx, [entry.subjectId], 'subjectId');
      await this.staff.requireTeacher(tx, entry.staffMemberId, institutionId, entry.subjectId);
    }
    if (
      await this.entries.sectionTaken(
        tx,
        entry.sectionId,
        entry.dayOfWeek,
        entry.timeSlotId,
        exceptId,
      )
    ) {
      throw AppException.conflict(ErrorCode.SECTION_SLOT_TAKEN);
    }
    if (entry.staffMemberId !== null) {
      const clash = await this.entries.teacherBooked(
        tx,
        entry.staffMemberId,
        entry.dayOfWeek,
        entry.timeSlotId,
        exceptId,
      );
      if (clash) {
        const named = (await this.sections.names(tx, [clash.section_id])).get(clash.section_id);
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.TEACHER_DOUBLE_BOOKED, {
          details: {
            conflict: named && { sectionName: named.displayName, className: named.className },
          },
        });
      }
    }
  }

  /** The names of the subjects, teachers and (except for a parent, who has no such names) sections of these entries. */
  private async namesOf(
    tx: Tx,
    rows: readonly TimetableEntryWithSlot[],
    parent: boolean,
  ): Promise<EntryNames> {
    const subjectIds = [
      ...new Set(rows.flatMap((row) => (row.subject_id ? [row.subject_id] : []))),
    ];
    const staffIds = [
      ...new Set(rows.flatMap((row) => (row.staff_member_id ? [row.staff_member_id] : []))),
    ];
    const sectionIds = [...new Set(rows.map((row) => row.section_id))];
    return {
      subjects: await this.subjects.names(tx, subjectIds),
      teachers: parent
        ? await this.staff.namesForParent(tx, staffIds)
        : await this.staff.names(tx, staffIds),
      sections: parent ? new Map() : await this.sections.names(tx, sectionIds),
    };
  }

  /** The entry as shown, read in the transaction that wrote it. */
  private async shown(
    tx: Tx,
    id: string,
  ): Promise<{ rows: TimetableEntryWithSlot[]; names: EntryNames }> {
    const rows = await this.entries.withSlots(tx, { ids: [id] });
    return { rows, names: await this.namesOf(tx, rows, false) };
  }

  private async resources(
    rows: readonly TimetableEntryWithSlot[],
    names: EntryNames,
  ): Promise<TimetableEntryResource[]> {
    const people = await this.people.describe(authorIdsOf(rows));
    return rows.map((row) => timetableEntryResource(row, names, people));
  }

  private async one(
    rows: readonly TimetableEntryWithSlot[],
    names: EntryNames,
  ): Promise<TimetableEntryResource> {
    return (await this.resources(rows, names))[0]!;
  }

  /** The Institution of a section named by its ID, which the caller must reach (404 otherwise, 422 when deactivated). */
  private async contextOfSection(
    principal: Principal,
    sectionId: string,
  ): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const place = await this.database.transaction(tenant, (tx) =>
      this.sections.placeOf(tx, sectionId),
    );
    if (!place) throw AppException.notFound();
    return this.scope.requireInstitution(principal, place.institutionId);
  }

  /** The Institution of an entry named by its ID alone, which the caller must reach (404 otherwise, and when removed). */
  private async contextOfEntry(principal: Principal, id: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.entries.find(tx, id));
    if (!found || found.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  private async lockedActive(tx: Tx, id: string): Promise<TimetableEntryRow> {
    const entry = await this.entries.find(tx, id, true);
    if (!entry || entry.status === 0) throw AppException.notFound();
    return entry;
  }

  /** The entry carries the Society and the Institution, so the Society's Owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    entry: TimetableEntryRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: entry.institution_id,
      societyId: entry.society_id,
      entityType: 'timetable_entry',
      entityId: entry.id,
      ...values,
    });
  }
}
