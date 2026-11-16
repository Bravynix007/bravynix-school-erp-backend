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
  type TenantContext,
  type Tx,
} from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { MasterReferences } from '../../platform/masters/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import { AcademicYearDirectory } from '../academic-setup/index.js';
import type {
  ChangeEventScopeDto,
  CreateEventDto,
  ListEventsQueryDto,
  UpdateEventDto,
} from './event.dto.js';
import {
  EventRepository,
  type EventChanges,
  type EventFilter,
  type EventRow,
} from './event.repository.js';
import { eventResource, type EventResource } from './event.resource.js';
import {
  EventScope,
  checkEventFields,
  checkRange,
  checkScope,
  mayEdit,
  visibleAudiences,
  type EventFields,
} from './event.rules.js';

/** What the audit log keeps of an event. */
function auditView(row: EventRow, classIds: readonly string[]): AuditValues {
  return {
    title: row.title,
    scope: row.scope,
    institutionId: row.institution_id,
    startDate: row.start_date,
    endDate: row.end_date,
    durationLabel: row.duration_label,
    audience: row.audience,
    isHoliday: row.is_holiday,
    holidayType: row.holiday_type,
    holidayForStudents: row.holiday_for_students,
    holidayForStaff: row.holiday_for_staff,
    holidayPredefinedClassIds: [...classIds],
    status: row.status,
  };
}

/** The holiday rules look at the stored row as they look at a request. */
function fieldsOf(row: EventRow, classIds: readonly string[]): EventFields {
  return {
    startDate: row.start_date,
    endDate: row.end_date,
    isHoliday: row.is_holiday,
    holidayType: row.holiday_type,
    holidayForStudents: row.holiday_for_students,
    holidayForStaff: row.holiday_for_staff,
    holidayPredefinedClassIds: classIds,
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * EVT-01 to EVT-06 (API design 9.10, 10.26, PRD 7.12): the calendar of a Society and its Institutions. The Owner makes
 * and changes every event and moves it between the Society and an Institution; an Institution Admin makes and changes
 * the events of their own Institutions; teachers and staff read what is for everyone or for staff.
 */
@Injectable()
export class EventService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: EventRepository,
    private readonly scopes: ScopeService,
    private readonly masters: MasterReferences,
    private readonly years: AcademicYearDirectory,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /**
   * EVT-01: the events with a day in a span of dates, or in an academic year of one Institution, earliest first. What
   * the caller reads is the Society's and their Institutions' events, for the audiences their role is told about;
   * naming an Institution narrows it to the Society-wide events and that Institution's.
   */
  async list(principal: Principal, query: ListEventsQueryDto): Promise<ApiResult<EventResource[]>> {
    const scope = await this.scopes.forPrincipal(principal);
    if (scope.societyId === null) throw AppException.forbidden();
    const tenant = query.institutionId
      ? (await this.scopes.requireInstitution(principal, query.institutionId)).tenant
      : scope.tenant;
    const { rows, classes } = await this.database.transaction(tenant, async (tx) => {
      const span = await this.span(tx, query);
      const found = await this.events.list(tx, {
        ...span,
        holidaysOnly: query.holidays === true,
        audiences: visibleAudiences(principal.roleCode),
      });
      return { rows: found, classes: await this.events.classesOf(tx, found.map((row) => row.id)) };
    });
    const people = await this.people.describe(authorIdsOf(rows));
    return ApiResult.list(
      rows.map((row) => eventResource(row, classes.get(row.id) ?? [], principal.roleCode, people)),
      null,
    );
  }

  /** EVT-03: one active event the caller reads; one that is not theirs, or not for their audience, is 404. */
  async get(principal: Principal, id: string): Promise<EventResource> {
    const { tenant } = await this.societyOf(principal);
    const found = await this.database.transaction(tenant, async (tx) => {
      const row = await this.events.find(tx, id);
      if (!row || row.status === 0 || !visibleAudiences(principal.roleCode).includes(row.audience)) {
        throw AppException.notFound();
      }
      return { row, classIds: (await this.events.classesOf(tx, [id])).get(id) ?? [] };
    });
    return this.resource(principal, found.row, found.classIds);
  }

  /**
   * EVT-02: an Owner makes either scope; an Admin only an Institution event of an Institution they administer (403
   * `SCOPE_NOT_ALLOWED` for the Society's). The classes a holiday names must exist and be shown.
   */
  async create(principal: Principal, body: CreateEventDto): Promise<EventResource> {
    const fields = this.requestFields(body);
    checkEventFields(fields);
    checkScope(body.scope, body.institutionId);
    if (body.scope === EventScope.Society && principal.roleCode !== RoleCode.SocietyOwner) {
      throw AppException.forbidden(ErrorCode.SCOPE_NOT_ALLOWED);
    }
    const { tenant, societyId } = await this.homeOf(principal, body.institutionId);
    const created = await this.database.transaction(tenant, async (tx) => {
      await this.requireClasses(tx, fields.holidayPredefinedClassIds, []);
      const row = await this.events.insert(tx, {
        id: newId(),
        society_id: societyId,
        scope: body.scope,
        institution_id: body.institutionId ?? null,
        title: body.title,
        description: body.description ?? null,
        venue: body.venue ?? null,
        start_date: body.startDate,
        end_date: body.endDate,
        duration_label: body.durationLabel,
        audience: body.audience ?? 1,
        preset_image_code: body.presetImageCode ?? null,
        is_holiday: fields.isHoliday,
        holiday_type: fields.holidayType,
        holiday_for_students: fields.holidayForStudents,
        holiday_for_staff: fields.holidayForStaff,
        ...insertStamp(principal.personId),
      });
      await this.events.replaceClasses(tx, row.id, societyId, fields.holidayPredefinedClassIds);
      await this.record(tx, 'event.created', row, {
        after: auditView(row, fields.holidayPredefinedClassIds),
      });
      return { row, classIds: [...fields.holidayPredefinedClassIds] };
    });
    return this.resource(principal, created.row, created.classIds);
  }

  /**
   * EVT-04: `version` first, then who may change it (403 `SCOPE_NOT_ALLOWED` for an Admin and a Society event). A field
   * left out stays; marking an event not a holiday clears its holiday fields and classes. A change that changes
   * nothing writes nothing.
   */
  async update(principal: Principal, id: string, body: UpdateEventDto): Promise<EventResource> {
    const { tenant } = await this.societyOf(principal);
    const result = await this.database.transaction(tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      requireVersion(current, body.version);
      this.requireMayEdit(principal, current);
      const currentClasses = (await this.events.classesOf(tx, [id])).get(id) ?? [];
      const notHoliday = body.isHoliday === false;
      const fields: EventFields = {
        startDate: body.startDate ?? current.start_date,
        endDate: body.endDate ?? current.end_date,
        isHoliday: body.isHoliday ?? current.is_holiday,
        holidayType: notHoliday
          ? (body.holidayType ?? null)
          : body.holidayType === undefined
            ? current.holiday_type
            : body.holidayType,
        holidayForStudents: notHoliday
          ? (body.holidayForStudents ?? false)
          : (body.holidayForStudents ?? current.holiday_for_students),
        holidayForStaff: notHoliday
          ? (body.holidayForStaff ?? false)
          : (body.holidayForStaff ?? current.holiday_for_staff),
        holidayPredefinedClassIds: notHoliday
          ? (body.holidayPredefinedClassIds ?? [])
          : (body.holidayPredefinedClassIds ?? currentClasses),
      };
      checkEventFields(fields);
      const wanted: EventChanges = {
        title: body.title,
        description: body.description,
        venue: body.venue,
        start_date: body.startDate,
        end_date: body.endDate,
        duration_label: body.durationLabel,
        audience: body.audience,
        preset_image_code: body.presetImageCode,
        is_holiday: fields.isHoliday,
        holiday_type: fields.holidayType,
        holiday_for_students: fields.holidayForStudents,
        holiday_for_staff: fields.holidayForStaff,
      };
      const changes = changedColumns(current, wanted);
      const classesChanged = !sameSet(fields.holidayPredefinedClassIds, currentClasses);
      if (Object.keys(changes).length === 0 && !classesChanged) {
        return { row: current, classIds: currentClasses };
      }
      await this.requireClasses(tx, fields.holidayPredefinedClassIds, currentClasses);
      const updated = await this.events.update(tx, id, {
        ...changes,
        ...updateStamp(principal.personId),
      });
      if (classesChanged) {
        await this.events.replaceClasses(tx, id, updated.society_id, fields.holidayPredefinedClassIds);
      }
      await this.record(tx, 'event.updated', updated, {
        before: auditView(current, currentClasses),
        after: auditView(updated, fields.holidayPredefinedClassIds),
      });
      return { row: updated, classIds: [...fields.holidayPredefinedClassIds] };
    });
    return this.resource(principal, result.row, result.classIds);
  }

  /** EVT-05: deactivates; nothing is deleted. 404 when already deactivated. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const { tenant } = await this.societyOf(principal);
    await this.database.transaction(tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      this.requireMayEdit(principal, current);
      const classIds = (await this.events.classesOf(tx, [id])).get(id) ?? [];
      const updated = await this.events.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'event.deactivated', updated, {
        before: auditView(current, classIds),
        after: auditView(updated, classIds),
      });
    });
    return { id, status: 0 };
  }

  /**
   * EVT-06 (Owner only): moves an event between the Society (shown in every Institution; Admins can only view it) and
   * one Institution (that Institution's Admins can edit it). An Institution scope names an Institution the Owner reaches.
   */
  async changeScope(
    principal: Principal,
    id: string,
    body: ChangeEventScopeDto,
  ): Promise<EventResource> {
    checkScope(body.scope, body.institutionId);
    const { tenant } = await this.societyOf(principal);
    const result = await this.database.transaction(tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      requireVersion(current, body.version);
      const classIds = (await this.events.classesOf(tx, [id])).get(id) ?? [];
      const institutionId = body.scope === EventScope.Institution ? body.institutionId! : null;
      if (body.scope === current.scope && institutionId === current.institution_id) {
        return { row: current, classIds };
      }
      if (institutionId !== null) await this.scopes.requireInstitution(principal, institutionId);
      const updated = await this.events.update(tx, id, {
        scope: body.scope,
        institution_id: institutionId,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'event.scope_changed', updated, {
        before: auditView(current, classIds),
        after: auditView(updated, classIds),
      });
      return { row: updated, classIds };
    });
    return this.resource(principal, result.row, result.classIds);
  }

  /** The days a list covers: the dates asked for, or the academic year named (400 `REQUIRED` for what is missing). */
  private async span(tx: Tx, query: ListEventsQueryDto): Promise<Pick<EventFilter, 'from' | 'to'>> {
    if (query.academicYearId !== undefined) {
      if (query.from !== undefined || query.to !== undefined) {
        throw AppException.validation([fieldError('from', FieldErrorCode.FIELD_NOT_ALLOWED)]);
      }
      if (query.institutionId === undefined) {
        throw AppException.validation([fieldError('institutionId', FieldErrorCode.REQUIRED)]);
      }
      const year = await this.years.openYear(tx, query.academicYearId, query.institutionId);
      if (!year) throw AppException.notFound();
      return { from: year.startDate, to: year.endDate };
    }
    const missing = [
      ...(query.from === undefined ? [fieldError('from', FieldErrorCode.REQUIRED)] : []),
      ...(query.to === undefined ? [fieldError('to', FieldErrorCode.REQUIRED)] : []),
    ];
    if (missing.length > 0) throw AppException.validation(missing);
    checkRange(query.from!, query.to!);
    return { from: query.from!, to: query.to! };
  }

  private requestFields(body: CreateEventDto): EventFields {
    return {
      startDate: body.startDate,
      endDate: body.endDate,
      isHoliday: body.isHoliday ?? false,
      holidayType: body.holidayType ?? null,
      holidayForStudents: body.holidayForStudents ?? false,
      holidayForStaff: body.holidayForStaff ?? false,
      holidayPredefinedClassIds: body.holidayPredefinedClassIds ?? [],
    };
  }

  /** The classes a holiday newly names must exist (404) and be shown (422 `REFERENCE_INACTIVE`). */
  private async requireClasses(
    tx: Tx,
    classIds: readonly string[],
    already: readonly string[],
  ): Promise<void> {
    const entries = classIds
      .map((id, index) => ({ id, field: `holidayPredefinedClassIds[${index.toString()}]` }))
      .filter((entry) => !already.includes(entry.id));
    if (entries.length > 0) await this.masters.requireAllShown(tx, 'predefined_classes', entries);
  }

  /** The Society the event is made in, and the tenant: narrowed to the Institution when it has one (404 if not theirs). */
  private async homeOf(
    principal: Principal,
    institutionId: string | undefined,
  ): Promise<{ tenant: TenantContext; societyId: string }> {
    if (institutionId !== undefined) {
      const context = await this.scopes.requireInstitution(principal, institutionId);
      return { tenant: context.tenant, societyId: context.societyId };
    }
    return this.societyOf(principal);
  }

  private async societyOf(principal: Principal): Promise<{ tenant: TenantContext; societyId: string }> {
    const scope = await this.scopes.forPrincipal(principal);
    if (scope.societyId === null) throw AppException.forbidden();
    return { tenant: scope.tenant, societyId: scope.societyId };
  }

  /** An Admin changes an Institution's event and not the Society's (403 `SCOPE_NOT_ALLOWED`). */
  private requireMayEdit(principal: Principal, row: EventRow): void {
    if (!mayEdit(principal.roleCode, row.scope)) {
      throw AppException.forbidden(ErrorCode.SCOPE_NOT_ALLOWED);
    }
  }

  /** The event, locked for the change; 404 when another Society's or an Institution out of scope (the database hides it), gone or deactivated. */
  private async lockedActive(tx: Tx, id: string): Promise<EventRow> {
    const row = await this.events.find(tx, id, true);
    if (!row || row.status === 0) throw AppException.notFound();
    return row;
  }

  private async resource(
    principal: Principal,
    row: EventRow,
    classIds: readonly string[],
  ): Promise<EventResource> {
    return eventResource(
      row,
      classIds,
      principal.roleCode,
      await this.people.describe(authorIdsOf([row])),
    );
  }

  /** The entry carries the event's Institution when it has one (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    event: EventRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: event.institution_id,
      societyId: event.society_id,
      entityType: 'event',
      entityId: event.id,
      ...values,
    });
  }

  // `fieldsOf` keeps the stored row and a request in one shape for the rules.
  static readonly fieldsOf = fieldsOf;
}
