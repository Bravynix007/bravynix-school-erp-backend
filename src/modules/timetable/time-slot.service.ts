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
import { AcademicYearDirectory } from '../academic-setup/index.js';
import type {
  CreateTimeSlotDto,
  ListTimeSlotsQueryDto,
  UpdateTimeSlotDto,
} from './time-slot.dto.js';
import {
  TimeSlotRepository,
  type TimeSlotChanges,
  type TimeSlotRow,
} from './time-slot.repository.js';
import { timeSlotResource, type TimeSlotResource } from './time-slot.resource.js';
import { clockOf, requireTimes, translateTimeSlotError } from './time-slot.rules.js';
import { TimetableEntryRepository } from './timetable-entry.repository.js';
import { TimetableChildren } from './timetable-children.js';

/** What the audit log keeps of a period. */
function auditView(row: TimeSlotRow): AuditValues {
  return {
    academic_year_id: row.academic_year_id,
    period_no: row.period_no,
    label: row.label,
    start_time: clockOf(row.start_time),
    end_time: clockOf(row.end_time),
    is_break: row.is_break,
    status: row.status,
  };
}

/**
 * TTS-01 to TTS-04 (API design 9.4): the period timings of one Institution's academic year. A Society Owner and an
 * Institution Admin of the Institution add, change and deactivate; everyone in its scope reads, and a parent reads
 * their child's Institution. The database refuses a repeated number and an overlap, whoever saves first.
 */
@Injectable()
export class TimeSlotService {
  constructor(
    private readonly database: DatabaseService,
    private readonly slots: TimeSlotRepository,
    private readonly entries: TimetableEntryRepository,
    private readonly scope: ScopeService,
    private readonly years: AcademicYearDirectory,
    private readonly children: TimetableChildren,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /**
   * TTS-01: the active periods of a year, earliest first. The year is the one named, or the Institution's current
   * year (422 `CURRENT_YEAR_REQUIRED` when it has none). A parent names their child, and reads the current year of
   * the child's Institution.
   */
  async list(
    principal: Principal,
    query: ListTimeSlotsQueryDto,
  ): Promise<ApiResult<TimeSlotResource[]>> {
    const context = await this.readContext(principal, query);
    const rows = await this.database.transaction(context.tenant, async (tx) => {
      const yearId =
        query.academicYearId === undefined
          ? await this.years.requireCurrentId(tx, context.institutionId)
          : await this.namedYear(tx, query.academicYearId, context.institutionId);
      return this.slots.active(tx, yearId);
    });
    const people = await this.people.describe(authorIdsOf(rows));
    return ApiResult.list(
      rows.map((row) => timeSlotResource(row, people)),
      null,
    );
  }

  /**
   * TTS-02: 400 `OUT_OF_RANGE` on `endTime` when it is not after the start, 409 `DUPLICATE` on `periodNo`, 409
   * `TIME_SLOT_OVERLAP`. The period joins the year named, which must be active, or the current year.
   */
  async create(principal: Principal, body: CreateTimeSlotDto): Promise<TimeSlotResource> {
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    requireTimes(body.startTime, body.endTime);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        const yearId =
          body.academicYearId === undefined
            ? await this.years.requireCurrentId(tx, context.institutionId)
            : await this.openYear(tx, body.academicYearId, context.institutionId);
        const created = await this.slots.insert(tx, {
          id: newId(),
          society_id: context.societyId,
          institution_id: context.institutionId,
          academic_year_id: yearId,
          period_no: body.periodNo,
          label: body.label ?? null,
          start_time: body.startTime,
          end_time: body.endTime,
          is_break: body.isBreak ?? false,
          ...insertStamp(principal.personId),
        });
        await this.record(tx, 'time_slot.created', created, { after: auditView(created) });
        return created;
      })
      .catch((error: unknown) => {
        throw translateTimeSlotError(error);
      });
    return this.resource(row);
  }

  /** TTS-03: a request that changes nothing writes nothing. A deactivated period is 404. */
  async update(
    principal: Principal,
    id: string,
    body: UpdateTimeSlotDto,
  ): Promise<TimeSlotResource> {
    const context = await this.contextOf(principal, id);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const wanted: TimeSlotChanges = {
          ...(body.label === undefined ? {} : { label: body.label }),
          ...(body.startTime === undefined ? {} : { start_time: body.startTime }),
          ...(body.endTime === undefined ? {} : { end_time: body.endTime }),
        };
        const changes = changedColumns(
          {
            ...current,
            start_time: clockOf(current.start_time),
            end_time: clockOf(current.end_time),
          },
          wanted,
        ) as TimeSlotChanges;
        if (Object.keys(changes).length === 0) return current;
        requireTimes(
          changes.start_time ?? clockOf(current.start_time),
          changes.end_time ?? clockOf(current.end_time),
        );
        const updated = await this.slots.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        await this.record(tx, 'time_slot.updated', updated, {
          before: auditView(current),
          after: auditView(updated),
        });
        return updated;
      })
      .catch((error: unknown) => {
        throw translateTimeSlotError(error);
      });
    return this.resource(row);
  }

  /**
   * TTS-04: deactivates the period, and its number and times are free again. 409 `TIME_SLOT_IN_USE` while an active
   * timetable entry sits in it. Nothing is deleted.
   */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      if (await this.entries.usesSlot(tx, id))
        throw AppException.conflict(ErrorCode.TIME_SLOT_IN_USE);
      const updated = await this.slots.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'time_slot.deactivated', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /**
   * Whose Institution a read is for. A parent names their child (400 `REQUIRED` without), and may not name an
   * Institution or a year; everyone else names the Institution (400 `REQUIRED` without) and has no child to name.
   */
  private async readContext(
    principal: Principal,
    query: ListTimeSlotsQueryDto,
  ): Promise<InstitutionContext> {
    if (principal.roleCode === RoleCode.StudentParent) {
      const errors = [
        ...(query.studentId === undefined
          ? [fieldError('studentId', FieldErrorCode.REQUIRED)]
          : []),
        ...(query.institutionId === undefined
          ? []
          : [fieldError('institutionId', FieldErrorCode.FIELD_NOT_ALLOWED)]),
        ...(query.academicYearId === undefined
          ? []
          : [fieldError('academicYearId', FieldErrorCode.FIELD_NOT_ALLOWED)]),
      ];
      if (errors.length > 0) throw AppException.validation(errors);
      return this.children.childContext(principal, query.studentId!);
    }
    const errors = [
      ...(query.institutionId === undefined
        ? [fieldError('institutionId', FieldErrorCode.REQUIRED)]
        : []),
      ...(query.studentId === undefined
        ? []
        : [fieldError('studentId', FieldErrorCode.FIELD_NOT_ALLOWED)]),
    ];
    if (errors.length > 0) throw AppException.validation(errors);
    return this.scope.requireInstitution(principal, query.institutionId!);
  }

  /** A year of the Institution, open or not, to read; 404 for any other. */
  private async namedYear(tx: Tx, yearId: string, institutionId: string): Promise<string> {
    if ((await this.years.openYear(tx, yearId, institutionId)) === undefined) {
      throw AppException.notFound();
    }
    return yearId;
  }

  /** A year of the Institution to add to: 404 for any other, 422 `REFERENCE_INACTIVE` when it is deactivated. */
  private async openYear(tx: Tx, yearId: string, institutionId: string): Promise<string> {
    await this.years.requireActive(tx, yearId, institutionId, 'academicYearId');
    return yearId;
  }

  /** The Institution of a period named by its ID alone, which the caller must reach (404 otherwise, and when deactivated). */
  private async contextOf(principal: Principal, id: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.slots.find(tx, id));
    if (!found || found.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  private async lockedActive(tx: Tx, id: string): Promise<TimeSlotRow> {
    const slot = await this.slots.find(tx, id, true);
    if (!slot || slot.status === 0) throw AppException.notFound();
    return slot;
  }

  private async resource(row: TimeSlotRow): Promise<TimeSlotResource> {
    return timeSlotResource(row, await this.people.describe(authorIdsOf([row])));
  }

  /** The entry carries the Society and the Institution, so the Society's Owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    slot: TimeSlotRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: slot.institution_id,
      societyId: slot.society_id,
      entityType: 'time_slot',
      entityId: slot.id,
      ...values,
    });
  }
}
