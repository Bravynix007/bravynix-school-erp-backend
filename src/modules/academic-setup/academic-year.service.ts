import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { newId } from '../../common/ids/ids.js';
import { requireVersion } from '../../common/http/require-version.js';
import { AuditService, type AuditValues } from '../../platform/audit/index.js';
import {
  DatabaseService,
  insertStamp,
  updateStamp,
  type Tx,
} from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { ScopeService, type InstitutionContext } from '../../platform/tenancy/index.js';
import type {
  CreateAcademicYearDto,
  ListAcademicYearsQueryDto,
  UpdateAcademicYearDto,
} from './academic-year.dto.js';
import {
  AcademicYearRepository,
  type AcademicYearChanges,
  type AcademicYearRow,
} from './academic-year.repository.js';
import { academicYearResource, type AcademicYearResource } from './academic-year.resource.js';
import { requireYearDates, translateYearError } from './academic-year.rules.js';

/** What the audit log keeps of a year. */
function auditView(row: AcademicYearRow): AuditValues {
  return {
    name: row.name,
    start_date: row.start_date,
    end_date: row.end_date,
    is_current: row.is_current,
    status: row.status,
  };
}

/**
 * AY-01 to AY-05 (API design 10.4h): the academic years of one Institution. A Society Owner and an Institution
 * Admin of the Institution add, change, make current and deactivate; everyone in its scope reads. Every write
 * takes the Institution's lock first, runs in one transaction with its audit entry, and checks `version` before
 * anything else.
 */
@Injectable()
export class AcademicYearService {
  constructor(
    private readonly database: DatabaseService,
    private readonly years: AcademicYearRepository,
    private readonly scope: ScopeService,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /** AY-01: the active years, the latest start first. */
  async list(
    principal: Principal,
    query: ListAcademicYearsQueryDto,
  ): Promise<ApiResult<AcademicYearResource[]>> {
    const { tenant } = await this.scope.requireInstitution(principal, query.institutionId);
    const rows = await this.database.transaction(tenant, (tx) =>
      this.years.active(tx, query.institutionId),
    );
    const people = await this.people.describe(authorIdsOf(rows));
    return ApiResult.list(
      rows.map((row) => academicYearResource(row, people)),
      null,
    );
  }

  /**
   * AY-02: 409 `DUPLICATE` on `name`, 409 `YEAR_OVERLAP`, 400 when the end is not after the start. The first
   * active year of an Institution becomes current (PRD 7.2: exactly one current year).
   */
  async create(principal: Principal, body: CreateAcademicYearDto): Promise<AcademicYearResource> {
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    requireYearDates(body.startDate, body.endDate);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        await this.years.lockInstitution(tx, body.institutionId);
        const created = await this.years.insert(tx, {
          id: newId(),
          society_id: context.societyId,
          institution_id: body.institutionId,
          name: body.name,
          start_date: body.startDate,
          end_date: body.endDate,
          is_current: !(await this.years.hasActive(tx, body.institutionId)),
          ...insertStamp(principal.personId),
        });
        await this.record(tx, 'academic_year.created', created, { after: auditView(created) });
        return created;
      })
      .catch((error: unknown) => {
        throw translateYearError(error);
      });
    return this.resource(row);
  }

  /** AY-03: a request that changes nothing writes nothing. A deactivated year is 404. */
  async update(
    principal: Principal,
    id: string,
    body: UpdateAcademicYearDto,
  ): Promise<AcademicYearResource> {
    const context = await this.contextOf(principal, id);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, context, id);
        requireVersion(current, body.version);
        const wanted: AcademicYearChanges = {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.startDate === undefined ? {} : { start_date: body.startDate }),
          ...(body.endDate === undefined ? {} : { end_date: body.endDate }),
        };
        const changes = Object.fromEntries(
          Object.entries(wanted).filter(
            ([column, value]) => current[column as keyof AcademicYearRow] !== value,
          ),
        ) as AcademicYearChanges;
        if (Object.keys(changes).length === 0) return current;
        requireYearDates(
          changes.start_date ?? current.start_date,
          changes.end_date ?? current.end_date,
        );
        const updated = await this.years.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        await this.record(tx, 'academic_year.updated', updated, {
          before: auditView(current),
          after: auditView(updated),
        });
        return updated;
      })
      .catch((error: unknown) => {
        throw translateYearError(error);
      });
    return this.resource(row);
  }

  /**
   * AY-04: the year becomes current and the one that was current stops being, together. Already current
   * writes nothing.
   */
  async makeCurrent(
    principal: Principal,
    id: string,
    version: number,
  ): Promise<AcademicYearResource> {
    const context = await this.contextOf(principal, id);
    const row = await this.database.transaction(context.tenant, async (tx) => {
      const year = await this.lockedActive(tx, context, id);
      requireVersion(year, version);
      if (year.is_current) return year;
      const previous = await this.years.currentOf(tx, year.institution_id);
      if (previous) {
        await this.years.update(tx, previous.id, {
          is_current: false,
          ...updateStamp(principal.personId),
        });
      }
      const updated = await this.years.update(tx, id, {
        is_current: true,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'academic_year.made_current', updated, {
        before: { is_current: false },
        after: { is_current: true, previous_year_id: previous?.id ?? null },
      });
      return updated;
    });
    return this.resource(row);
  }

  /** AY-05: deactivates the year; the current one cannot be (409 `CURRENT_YEAR_LOCKED`). Nothing is deleted. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const year = await this.lockedActive(tx, context, id);
      if (year.is_current) throw AppException.conflict(ErrorCode.CURRENT_YEAR_LOCKED);
      const updated = await this.years.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'academic_year.deactivated', updated, {
        before: auditView(year),
        after: auditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /**
   * The Institution of a year named by its ID alone, which the caller must reach (404 for a year in another
   * Society, or an Institution outside their scope, and for a deactivated one).
   */
  private async contextOf(principal: Principal, id: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const year = await this.database.transaction(tenant, (tx) => this.years.find(tx, id));
    if (!year || year.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, year.institution_id);
  }

  /** The year, locked for the change, after the Institution's lock; 404 when it is gone or deactivated. */
  private async lockedActive(
    tx: Tx,
    context: InstitutionContext,
    id: string,
  ): Promise<AcademicYearRow> {
    await this.years.lockInstitution(tx, context.institutionId);
    const year = await this.years.find(tx, id, true);
    if (!year || year.status === 0) throw AppException.notFound();
    return year;
  }

  private async resource(row: AcademicYearRow): Promise<AcademicYearResource> {
    return academicYearResource(row, await this.people.describe(authorIdsOf([row])));
  }

  /** The entry carries the Society and the Institution, so the Society's Owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    year: AcademicYearRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: year.institution_id,
      societyId: year.society_id,
      entityType: 'academic_year',
      entityId: year.id,
      ...values,
    });
  }
}
