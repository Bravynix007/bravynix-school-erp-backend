import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { newId } from '../../common/ids/ids.js';
import { Clock } from '../../common/time/clock.js';
import { formatDay } from '../../common/time/format-day.js';
import { fieldError } from '../../common/validation/field-error.js';
import { parentReadErrors, staffReadErrors } from '../../common/validation/parent-read.js';
import { AuditService, type AuditValues } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { Notifications } from '../../platform/notifications/index.js';
import {
  ChildContexts,
  ScopeService,
  type InstitutionContext,
} from '../../platform/tenancy/index.js';
import {
  AcademicYearDirectory,
  SectionDirectory,
  StaffDirectory,
  SubjectDirectory,
  TeachingStaff,
  type SubjectResource,
} from '../academic-setup/index.js';
import { DiaryPeople } from './diary-people.js';
import type {
  CreateDiaryEntryDto,
  ListDiaryQueryDto,
  ListDiarySubjectsQueryDto,
  UpdateDiaryEntryDto,
} from './diary.dto.js';
import { DiaryRepository, type DiaryEntryChanges, type DiaryEntryRow } from './diary.repository.js';
import { diaryEntryResource, type DiaryEntryResource, type DiaryNames } from './diary.resource.js';
import { requireDiaryDate } from './diary.rules.js';

/** The screen and category of the notice to a parent (DDD 9.8): 2 Diary. */
const DIARY_TARGET = 2;
const DIARY_CATEGORY = 2;
/** "Only for you" in the inbox. */
const ONLY_FOR_YOU = 1;

/** What the audit log keeps of an entry. */
function auditView(row: DiaryEntryRow): AuditValues {
  return {
    section_id: row.section_id,
    subject_id: row.subject_id,
    diary_date: row.diary_date,
    description: row.description,
    status: row.status,
  };
}

/** What a read is about, and whose tenant it runs in. */
interface Target {
  context: InstitutionContext;
  /** A parent's child, whose section is found inside the transaction. */
  studentId?: string;
  sectionId?: string;
}

/**
 * DIA-01 to DIA-04 (API design 9.7, 10.14a): the diary of a section (PRD 7.9). A Society Owner and an Institution
 * Admin write for any section and subject of their Institutions; a teacher writes at their home Institution only, for
 * the sections and subjects they teach and any subject of the section they lead (Phase 5 decision 6), and changes or
 * removes only their own entries. A parent reads their child's section, and is told of each new entry.
 */
@Injectable()
export class DiaryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly entries: DiaryRepository,
    private readonly scope: ScopeService,
    private readonly years: AcademicYearDirectory,
    private readonly sections: SectionDirectory,
    private readonly subjects: SubjectDirectory,
    private readonly teaching: TeachingStaff,
    private readonly staff: StaffDirectory,
    private readonly diary: DiaryPeople,
    private readonly childContexts: ChildContexts,
    private readonly people: PersonDirectory,
    private readonly notifications: Notifications,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * DIA-01: the active entries of a section on a date, in the order they were written: a section the caller reaches (a
   * teacher reads only one they lead or teach, 403 `NOT_ASSIGNED`), or a parent's own child's section.
   */
  async list(
    principal: Principal,
    query: ListDiaryQueryDto,
  ): Promise<ApiResult<DiaryEntryResource[]>> {
    const parent = principal.roleCode === RoleCode.StudentParent;
    const target = await this.target(principal, query);
    const { rows, names } = await this.database.transaction(target.context.tenant, async (tx) => {
      const sectionId = await this.sectionOf(tx, principal, target);
      const found = sectionId === null ? [] : await this.entries.list(tx, sectionId, query.date);
      return { rows: found, names: await this.namesOf(tx, found, parent) };
    });
    return ApiResult.list(await this.resources(rows, names), null);
  }

  /**
   * DIA-05: the active subjects the caller may write the diary for in a section, so the form offers only what DIA-02
   * accepts. An Owner or Admin gets every subject of the Society; a teacher at their home Institution gets every
   * subject when they lead the section (a class teacher covers for a colleague on leave), else the subjects they
   * teach in it. The order is that of DIA-02: 404 for a section out of reach, 422 `REFERENCE_INACTIVE` for a closed
   * one, 422 `CURRENT_YEAR_REQUIRED`, 403 `NOT_ASSIGNED` for a teacher away from their home Institution or who
   * neither leads nor teaches in the section.
   */
  async writableSubjects(
    principal: Principal,
    query: ListDiarySubjectsQueryDto,
  ): Promise<ApiResult<SubjectResource[]>> {
    const context = await this.sections.contextOf(principal, query.sectionId);
    const rows = await this.database.transaction(context.tenant, async (tx) => {
      await this.sections.requireActive(tx, query.sectionId, 'sectionId');
      const yearId = await this.years.requireCurrentId(tx, context.institutionId);
      if (principal.roleCode !== RoleCode.TeacherStaff) {
        return this.subjects.active(tx, context.societyId);
      }
      const own = await this.staff.ownRecord(tx, principal.personId);
      const ids =
        own?.homeInstitutionId === context.institutionId
          ? await this.diary.diarySubjectIds(tx, own.staffMemberId, yearId, query.sectionId)
          : [];
      if (ids?.length === 0) throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
      return this.subjects.active(tx, context.societyId, ids ?? undefined);
    });
    return ApiResult.list(await this.subjects.resources(rows), null);
  }

  /**
   * DIA-02: an entry for a section and subject. 404 for a section out of reach, 422 `REFERENCE_INACTIVE` for a section
   * or subject that is closed, 422 `CURRENT_YEAR_REQUIRED`, 403 `NOT_ASSIGNED` for a teacher away from their home
   * Institution or without the section and subject, then the date rules. The section's parents are told in the same
   * transaction.
   */
  async create(principal: Principal, body: CreateDiaryEntryDto): Promise<DiaryEntryResource> {
    const context = await this.sections.contextOf(principal, body.sectionId);
    const { row, names } = await this.database.transaction(context.tenant, async (tx) => {
      await this.sections.requireActive(tx, body.sectionId, 'sectionId');
      await this.subjects.requireActive(tx, [body.subjectId], 'subjectId');
      const yearId = await this.years.requireCurrentId(tx, context.institutionId);
      const own = await this.staff.ownRecord(tx, principal.personId);
      if (principal.roleCode === RoleCode.TeacherStaff) {
        await this.requireMayWrite(tx, own, context.institutionId, yearId, {
          sectionId: body.sectionId,
          subjectId: body.subjectId,
        });
      }
      const year = (await this.years.openYear(tx, yearId, context.institutionId))!;
      const today = this.clock.todayIst();
      requireDiaryDate(body.diaryDate, today, year);
      const created = await this.entries.insert(tx, {
        id: newId(),
        society_id: context.societyId,
        institution_id: context.institutionId,
        academic_year_id: yearId,
        section_id: body.sectionId,
        subject_id: body.subjectId,
        staff_member_id:
          own?.homeInstitutionId === context.institutionId ? own.staffMemberId : null,
        diary_date: body.diaryDate,
        description: body.description,
        ...insertStamp(principal.personId),
      });
      await this.record(tx, 'diary_entry.created', created, { after: auditView(created) });
      const shown = await this.namesOf(tx, [created], false);
      await this.tellParents(
        tx,
        created,
        shown.subjects.get(body.subjectId) ?? '',
        principal,
        today,
      );
      return { row: created, names: shown };
    });
    return (await this.resources([row], names))[0]!;
  }

  /**
   * DIA-03: the subject, the date or the description; versioned. Only an Owner, an Admin or the teacher who wrote it
   * (403 `NOT_ASSIGNED` for any other teacher), who may write the new subject too. A request that changes nothing
   * writes nothing; a removed entry is 404. A new date is checked as for DIA-02, an unchanged one is not.
   */
  async update(
    principal: Principal,
    id: string,
    body: UpdateDiaryEntryDto,
  ): Promise<DiaryEntryResource> {
    const context = await this.contextOfEntry(principal, id);
    const { row, names } = await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      requireVersion(current, body.version);
      const own = await this.staff.ownRecord(tx, principal.personId);
      await this.requireAuthorOrAdmin(principal, own, current);
      const changes = changedColumns(current, {
        subject_id: body.subjectId ?? current.subject_id,
        diary_date: body.diaryDate ?? current.diary_date,
        description: body.description ?? current.description,
      }) as DiaryEntryChanges;
      if (Object.keys(changes).length === 0) {
        return { row: current, names: await this.namesOf(tx, [current], false) };
      }
      if (changes.subject_id !== undefined) {
        await this.subjects.requireActive(tx, [changes.subject_id], 'subjectId');
        if (principal.roleCode === RoleCode.TeacherStaff) {
          await this.requireMayWrite(tx, own, context.institutionId, current.academic_year_id, {
            sectionId: current.section_id,
            subjectId: changes.subject_id,
          });
        }
      }
      if (changes.diary_date !== undefined) {
        const year = (await this.years.openYear(
          tx,
          current.academic_year_id,
          context.institutionId,
        ))!;
        requireDiaryDate(changes.diary_date, this.clock.todayIst(), year);
      }
      const updated = await this.entries.update(tx, id, {
        ...changes,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'diary_entry.updated', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
      return { row: updated, names: await this.namesOf(tx, [updated], false) };
    });
    return (await this.resources([row], names))[0]!;
  }

  /** DIA-04: removes the entry: `status` 0, and it leaves the lists. Nothing is deleted. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOfEntry(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const own = await this.staff.ownRecord(tx, principal.personId);
      await this.requireAuthorOrAdmin(principal, own, current);
      const updated = await this.entries.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'diary_entry.deactivated', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /**
   * Whose section a read is for. A parent names their child (400 `REQUIRED` without) and nothing else. Everyone else
   * names a section and has no child to name.
   */
  private async target(principal: Principal, query: ListDiaryQueryDto): Promise<Target> {
    if (principal.roleCode === RoleCode.StudentParent) {
      const errors = parentReadErrors(query, ['sectionId']);
      if (errors.length > 0) throw AppException.validation(errors);
      const studentId = query.studentId!;
      return { context: await this.childContexts.of(principal, studentId), studentId };
    }
    const errors = [
      ...staffReadErrors(query),
      ...(query.sectionId === undefined ? [fieldError('sectionId', FieldErrorCode.REQUIRED)] : []),
    ];
    if (errors.length > 0) throw AppException.validation(errors);
    return {
      context: await this.sections.contextOf(principal, query.sectionId!),
      sectionId: query.sectionId,
    };
  }

  /** The section to read, inside its transaction: a parent's child's (`null` for a child in none) or the one named. */
  private async sectionOf(tx: Tx, principal: Principal, target: Target): Promise<string | null> {
    if (target.studentId !== undefined) {
      return (await this.diary.currentSectionId(tx, target.studentId)) ?? null;
    }
    if (principal.roleCode === RoleCode.TeacherStaff) {
      const own = await this.teaching.ownSectionIds(
        tx,
        principal.personId,
        target.context.institutionId,
      );
      if (!own.has(target.sectionId!)) throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
    }
    return target.sectionId!;
  }

  /** A teacher writes at their home Institution only, and only what they teach or lead: 403 `NOT_ASSIGNED` else. */
  private async requireMayWrite(
    tx: Tx,
    own: { staffMemberId: string; homeInstitutionId: string } | undefined,
    institutionId: string,
    yearId: string,
    place: { sectionId: string; subjectId: string },
  ): Promise<void> {
    const allowed =
      own?.homeInstitutionId === institutionId &&
      (await this.diary.mayWrite(tx, own.staffMemberId, yearId, place.sectionId, place.subjectId));
    if (!allowed) throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
  }

  /** An Owner or an Admin may change any entry of their Institution; a teacher only their own. */
  private requireAuthorOrAdmin(
    principal: Principal,
    own: { staffMemberId: string } | undefined,
    entry: DiaryEntryRow,
  ): void {
    if (
      principal.roleCode === RoleCode.TeacherStaff &&
      (own === undefined || own.staffMemberId !== entry.staff_member_id)
    ) {
      throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
    }
  }

  /**
   * One notice for the entry, to the guardians with a login of the students now in the section. The key is the entry,
   * so a job that runs twice tells no one twice. The text names the subject and the day and no more (SDD 18).
   */
  private async tellParents(
    tx: Tx,
    entry: DiaryEntryRow,
    subjectName: string,
    principal: Principal,
    today: string,
  ): Promise<void> {
    const receivers = await this.diary.receiversOf(tx, entry.section_id, today);
    if (receivers.length === 0) return;
    await this.notifications.notify(
      tx,
      {
        societyId: entry.society_id,
        institutionId: entry.institution_id,
        sourceKey: `diary:${entry.id}`,
        occurredAt: entry.created_at,
        category: DIARY_CATEGORY,
        tab: ONLY_FOR_YOU,
        title: 'New diary entry',
        body: `${subjectName}: a diary entry for ${formatDay(entry.diary_date)}.`,
        target: { type: DIARY_TARGET, id: entry.id, date: entry.diary_date },
        receivers,
      },
      principal.personId,
    );
  }

  /** The names of the subjects, teachers and (except for a parent, who has no such names) sections of these entries. */
  private async namesOf(
    tx: Tx,
    rows: readonly DiaryEntryRow[],
    parent: boolean,
  ): Promise<DiaryNames> {
    const staffIds = [
      ...new Set(rows.flatMap((row) => (row.staff_member_id ? [row.staff_member_id] : []))),
    ];
    return {
      subjects: await this.subjects.names(tx, [...new Set(rows.map((row) => row.subject_id))]),
      teachers: parent
        ? await this.staff.namesForParent(tx, staffIds)
        : await this.staff.names(tx, staffIds),
      sections: parent
        ? new Map()
        : await this.sections.names(tx, [...new Set(rows.map((row) => row.section_id))]),
    };
  }

  private async resources(
    rows: readonly DiaryEntryRow[],
    names: DiaryNames,
  ): Promise<DiaryEntryResource[]> {
    const people = await this.people.describe(authorIdsOf(rows));
    return rows.map((row) => diaryEntryResource(row, names, people));
  }

  /** The Institution of an entry named by its ID alone, which the caller must reach (404 otherwise, and when removed). */
  private async contextOfEntry(principal: Principal, id: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.entries.find(tx, id));
    if (!found || found.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  private async lockedActive(tx: Tx, id: string): Promise<DiaryEntryRow> {
    const entry = await this.entries.find(tx, id, true);
    if (!entry || entry.status === 0) throw AppException.notFound();
    return entry;
  }

  /** The entry carries the Society and the Institution, so the Society's Owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    entry: DiaryEntryRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: entry.institution_id,
      societyId: entry.society_id,
      entityType: 'diary_entry',
      entityId: entry.id,
      ...values,
    });
  }
}
