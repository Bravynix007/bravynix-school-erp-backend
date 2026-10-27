import { Injectable } from '@nestjs/common';
import { requireVersion } from '../../common/http/require-version.js';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { newId } from '../../common/ids/ids.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService, type AuditValues } from '../audit/index.js';
import {
  DatabaseService,
  duplicateOn,
  insertStamp,
  isDuplicateOn,
  platformTenant,
  updateStamp,
  type TenantContext,
  type Tx,
} from '../database/index.js';
import { GrantDirectory, PersonDirectory } from '../identity/index.js';
import {
  INSTITUTION_SORT_FIELDS,
  type CreateInstitutionDto,
  type ListInstitutionsQueryDto,
  type UpdateInstitutionDto,
} from './institution.dto.js';
import {
  InstitutionRepository,
  type InstitutionChanges,
  type InstitutionRow,
} from './institution.repository.js';
import {
  institutionOption,
  institutionResource,
  institutionSummary,
  peopleOfInstitutions,
  type InstitutionOption,
  type InstitutionResource,
  type InstitutionSummary,
} from './institution.resource.js';
import { addressColumns, contactColumns } from './profile-columns.js';
import { requireActive } from './record-rules.js';
import { ScopeService } from './scope.service.js';
import { SocietyRepository } from './society.repository.js';

/** Why the Admin grants of a deactivated Institution were revoked. */
export const INSTITUTION_DEACTIVATED = 'institution_deactivated';

type Profile = Partial<Omit<CreateInstitutionDto, 'societyId' | 'name' | 'code'>>;

/** The columns a request's profile fields set. An omitted field is left out; `null` clears it. */
function profileColumns(profile: Profile): InstitutionChanges {
  const columns: InstitutionChanges = { ...contactColumns(profile) };
  if (profile.place !== undefined) columns.place = profile.place;
  if (profile.boardCode !== undefined) columns.board_code = profile.boardCode;
  if (profile.affiliationNumber !== undefined)
    columns.affiliation_number = profile.affiliationNumber;
  if (profile.gstin !== undefined) columns.gstin = profile.gstin;
  if (profile.telephone !== undefined) columns.telephone = profile.telephone;
  if (profile.address !== undefined) Object.assign(columns, addressColumns(profile.address));
  if (profile.location !== undefined) {
    // numeric(9,6) is kept as an exact decimal string.
    columns.latitude = profile.location?.latitude.toFixed(6) ?? null;
    columns.longitude = profile.location?.longitude.toFixed(6) ?? null;
  }
  return columns;
}

/** What the audit log keeps of an Institution: its own fields, nothing derived. */
function auditView(row: InstitutionRow): AuditValues {
  return {
    name: row.name,
    code: row.code,
    place: row.place,
    board_code: row.board_code,
    affiliation_number: row.affiliation_number,
    gstin: row.gstin,
    email: row.email,
    country_code: row.country_code,
    phone_number: row.phone_number,
    telephone: row.telephone,
    address_line_1: row.address_line_1,
    address_line_2: row.address_line_2,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    status: row.status,
  };
}

/**
 * INS-01 to INS-05 and PLT-19 (API design 10.4c). A Society Owner adds and
 * changes the Institutions of their own Society; Super Admin only looks across
 * Societies (PLT-19). Every change runs in one transaction with its audit
 * entry, and the row is locked for the check of `version` and state.
 */
@Injectable()
export class InstitutionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly institutions: InstitutionRepository,
    private readonly societies: SocietyRepository,
    private readonly scope: ScopeService,
    private readonly people: PersonDirectory,
    private readonly grants: GrantDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** INS-01: the active Institutions the caller reaches, by name. */
  async options(principal: Principal): Promise<ApiResult<InstitutionOption[]>> {
    const scope = await this.scope.forPrincipal(principal);
    const rows =
      scope.societyId === null
        ? []
        : await this.database.transaction(scope.tenant, (tx) =>
            this.institutions.activeAmong(tx, scope.societyId!, scope.tenant.institutionIds ?? []),
          );
    const people = await this.people.describe(peopleOfInstitutions(rows));
    return ApiResult.list(
      rows.map((row) => institutionOption(row, people)),
      null,
    );
  }

  /** PLT-19. */
  async list(
    principal: Principal,
    query: ListInstitutionsQueryDto,
  ): Promise<ApiResult<InstitutionSummary[]>> {
    const sort = parseSort(query.sort, INSTITUTION_SORT_FIELDS, [
      { field: 'name', direction: 'asc' },
    ]);
    const { rows, total } = await this.database.transaction(platformTenant(principal), (tx) =>
      this.institutions.page(
        tx,
        { q: query.q, societyId: query.societyId, statuses: query.status, blocked: query.blocked },
        sort,
        query.limit,
        pageOffset(query.page, query.limit),
      ),
    );
    const people = await this.people.describe(peopleOfInstitutions(rows));
    return ApiResult.list(
      rows.map((row) => institutionSummary(row, people)),
      pageMeta(query.page, query.limit, total),
    );
  }

  /** INS-03: inside the caller's scope only; an Institution whose staff are blocked answers 423 to its staff. */
  async get(principal: Principal, id: string): Promise<InstitutionResource> {
    const { tenant } = await this.scope.requireInstitution(principal, id);
    const row = await this.database.transaction(tenant, (tx) => this.mustFind(tx, id));
    return this.resource(row);
  }

  async create(principal: Principal, body: CreateInstitutionDto): Promise<InstitutionResource> {
    const societyId = principal.societyId;
    if (societyId === null) throw AppException.forbidden();
    const id = newId();
    const tenant: TenantContext = {
      personId: principal.personId,
      roleCode: principal.roleCode,
      societyId,
      institutionIds: [id],
    };
    const row = await this.database
      .transaction(tenant, async (tx) => {
        const society = await this.societies.find(tx, societyId);
        if (!society) throw AppException.notFound();
        requireActive(society);
        await this.institutions.insert(tx, {
          id,
          society_id: societyId,
          name: body.name,
          code: body.code,
          ...profileColumns(body),
          ...addressColumns(body.address),
          ...insertStamp(principal.personId),
        });
        const created = await this.mustFind(tx, id);
        await this.record(tx, 'institution.create', created, { after: auditView(created) });
        return created;
      })
      .catch((error: unknown) => {
        throw isDuplicateOn(error, 'uq_institutions_society_code') ? duplicateOn('code') : error;
      });
    return this.resource(row);
  }

  async update(
    principal: Principal,
    id: string,
    body: UpdateInstitutionDto,
  ): Promise<InstitutionResource> {
    const { tenant } = await this.scope.requireInstitution(principal, id);
    const row = await this.database.transaction(tenant, async (tx) => {
      const current = await this.lockedAt(tx, id, body.version);
      requireActive(current);
      const wanted: InstitutionChanges = {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...profileColumns(body),
      };
      // A request that changes nothing writes nothing: no new version, no audit entry.
      const changes = Object.fromEntries(
        Object.entries(wanted).filter(
          ([column, value]) => current[column as keyof InstitutionRow] !== value,
        ),
      ) as InstitutionChanges;
      if (Object.keys(changes).length === 0) return current;
      await this.institutions.update(tx, id, { ...changes, ...updateStamp(principal.personId) });
      const updated = await this.mustFind(tx, id);
      await this.record(tx, 'institution.update', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
      return updated;
    });
    return this.resource(row);
  }

  /** Deactivates; the Admin grants for it end, so an Admin with no other Institution loses the role. */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const { tenant } = await this.scope.requireInstitution(principal, id);
    await this.database.transaction(tenant, async (tx) => {
      const current = await this.institutions.find(tx, id, true);
      if (!current) throw AppException.notFound();
      requireActive(current);
      await this.institutions.update(tx, id, { status: 0, ...updateStamp(principal.personId) });
      const grantsRevoked = await this.grants.endAdminAccessInInstitution(
        tx,
        id,
        principal.personId,
        INSTITUTION_DEACTIVATED,
        this.clock.now(),
      );
      await this.record(tx, 'institution.deactivate', current, {
        before: { status: 1 },
        after: { status: 0, grantsRevoked },
      });
    });
    return { id, status: 0 };
  }

  /** The row, locked, for a change that names the `version` the client read. */
  private async lockedAt(tx: Tx, id: string, version: number): Promise<InstitutionRow> {
    const row = await this.institutions.find(tx, id, true);
    if (!row) throw AppException.notFound();
    requireVersion(row, version);
    return row;
  }

  private async mustFind(tx: Tx, id: string): Promise<InstitutionRow> {
    const row = await this.institutions.find(tx, id);
    if (!row) throw AppException.notFound();
    return row;
  }

  private async resource(row: InstitutionRow): Promise<InstitutionResource> {
    return institutionResource(row, await this.people.describe(peopleOfInstitutions([row])));
  }

  /** The audit entry carries the Society's and the Institution's IDs, so the Society's owners see it (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    institution: InstitutionRow,
    values: { reason?: string; before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: institution.id,
      societyId: institution.society_id,
      entityType: 'institution',
      entityId: institution.id,
      ...values,
    });
  }
}
