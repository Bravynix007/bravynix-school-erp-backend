import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { changedColumns } from '../../common/http/changed-columns.js';
import { FieldErrorCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { newId } from '../../common/ids/ids.js';
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
import {
  ChildContexts,
  ScopeService,
  type InstitutionContext,
} from '../../platform/tenancy/index.js';
import type {
  CreateGradeBandDto,
  ListGradeBandsQueryDto,
  UpdateGradeBandDto,
} from './grade-band.dto.js';
import {
  GradeBandRepository,
  type GradeBandChanges,
  type GradeBandRow,
} from './grade-band.repository.js';
import { gradeBandResource, type GradeBandResource } from './grade-band.resource.js';
import { decimalOf, requireRange, translateGradeBandError } from './grade-band.rules.js';

/** A band as numbers, the way the API writes it and the audit log keeps it. */
function valuesOf(row: GradeBandRow) {
  return {
    name: row.name,
    min_percentage: decimalOf(row.min_percentage),
    max_percentage: decimalOf(row.max_percentage),
    grade_point: decimalOf(row.grade_point),
    description: row.description,
  };
}

/** What the audit log keeps of a band. */
function auditView(row: GradeBandRow): AuditValues {
  return { ...valuesOf(row), status: row.status };
}

/**
 * GRD-01 to GRD-04 (API design 9.4): the grade bands of one Institution (PRD 7.11 step 7). A Society Owner and an
 * Institution Admin of the Institution add, change and deactivate; everyone in its scope reads, and a parent reads
 * their child's Institution. The database refuses a repeated name and an overlap, whoever saves first. A change never
 * alters a published result, which keeps the grade name it was published with.
 */
@Injectable()
export class GradeBandService {
  constructor(
    private readonly database: DatabaseService,
    private readonly bands: GradeBandRepository,
    private readonly scope: ScopeService,
    private readonly children: ChildContexts,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /** GRD-01: the active bands, the highest first. A parent names their child and reads the child's Institution. */
  async list(
    principal: Principal,
    query: ListGradeBandsQueryDto,
  ): Promise<ApiResult<GradeBandResource[]>> {
    const context = await this.readContext(principal, query);
    const rows = await this.database.transaction(context.tenant, (tx) =>
      this.bands.active(tx, context.institutionId),
    );
    const people = await this.people.describe(authorIdsOf(rows));
    return ApiResult.list(
      rows.map((row) => gradeBandResource(row, people)),
      null,
    );
  }

  /**
   * GRD-02: 400 `OUT_OF_RANGE` on `maxPercentage` when it is below the minimum, 409 `DUPLICATE` on `name`, 409
   * `GRADE_BAND_OVERLAP`.
   */
  async create(principal: Principal, body: CreateGradeBandDto): Promise<GradeBandResource> {
    const context = await this.scope.requireInstitution(principal, body.institutionId);
    requireRange(body.minPercentage, body.maxPercentage);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        const created = await this.bands.insert(tx, {
          id: newId(),
          society_id: context.societyId,
          institution_id: context.institutionId,
          name: body.name,
          min_percentage: body.minPercentage,
          max_percentage: body.maxPercentage,
          grade_point: body.gradePoint ?? null,
          description: body.description ?? null,
          ...insertStamp(principal.personId),
        });
        await this.record(tx, 'grade_band.created', created, { after: auditView(created) });
        return created;
      })
      .catch((error: unknown) => {
        throw translateGradeBandError(error);
      });
    return this.resource(row);
  }

  /** GRD-03: versioned; a request that changes nothing writes nothing. A deactivated band is 404. */
  async update(
    principal: Principal,
    id: string,
    body: UpdateGradeBandDto,
  ): Promise<GradeBandResource> {
    const context = await this.contextOf(principal, id);
    const row = await this.database
      .transaction(context.tenant, async (tx) => {
        const current = await this.lockedActive(tx, id);
        requireVersion(current, body.version);
        const stored = valuesOf(current);
        const changes = changedColumns(stored, {
          name: body.name,
          min_percentage: body.minPercentage,
          max_percentage: body.maxPercentage,
          grade_point: body.gradePoint,
          description: body.description,
        }) as GradeBandChanges;
        if (Object.keys(changes).length === 0) return current;
        requireRange(
          (changes.min_percentage as number | undefined) ?? stored.min_percentage,
          (changes.max_percentage as number | undefined) ?? stored.max_percentage,
        );
        const updated = await this.bands.update(tx, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        await this.record(tx, 'grade_band.updated', updated, {
          before: auditView(current),
          after: auditView(updated),
        });
        return updated;
      })
      .catch((error: unknown) => {
        throw translateGradeBandError(error);
      });
    return this.resource(row);
  }

  /** GRD-04: deactivates the band; its name and range are free again. Nothing is deleted. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const context = await this.contextOf(principal, id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.lockedActive(tx, id);
      const updated = await this.bands.update(tx, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'grade_band.deactivated', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
    });
    return { id, status: 0 };
  }

  /**
   * Whose Institution a read is for. A parent names their child (400 `REQUIRED` without), and may not name an
   * Institution; everyone else names the Institution (400 `REQUIRED` without) and has no child to name.
   */
  private async readContext(
    principal: Principal,
    query: ListGradeBandsQueryDto,
  ): Promise<InstitutionContext> {
    if (principal.roleCode === RoleCode.StudentParent) {
      const errors = parentReadErrors(query, ['institutionId']);
      if (errors.length > 0) throw AppException.validation(errors);
      return this.children.of(principal, query.studentId!);
    }
    const errors = [
      ...(query.institutionId === undefined
        ? [fieldError('institutionId', FieldErrorCode.REQUIRED)]
        : []),
      ...staffReadErrors(query),
    ];
    if (errors.length > 0) throw AppException.validation(errors);
    return this.scope.requireInstitution(principal, query.institutionId!);
  }

  /** The Institution of a band named by its ID alone, which the caller must reach (404 otherwise, and when deactivated). */
  private async contextOf(principal: Principal, id: string): Promise<InstitutionContext> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.bands.find(tx, id));
    if (!found || found.status === 0) throw AppException.notFound();
    return this.scope.requireInstitution(principal, found.institution_id);
  }

  private async lockedActive(tx: Tx, id: string): Promise<GradeBandRow> {
    const band = await this.bands.find(tx, id, true);
    if (!band || band.status === 0) throw AppException.notFound();
    return band;
  }

  private async resource(row: GradeBandRow): Promise<GradeBandResource> {
    return gradeBandResource(row, await this.people.describe(authorIdsOf([row])));
  }

  /** The entry carries the Society and the Institution, so the Society's Owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    band: GradeBandRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: band.institution_id,
      societyId: band.society_id,
      entityType: 'grade_band',
      entityId: band.id,
      ...values,
    });
  }
}
