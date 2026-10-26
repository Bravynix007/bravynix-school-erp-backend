import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { message } from '../../common/i18n/messages.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { newId } from '../../common/ids/ids.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService, type AuditValues } from '../audit/index.js';
import {
  DatabaseService,
  insertStamp,
  PgErrorCode,
  updateStamp,
  type TenantContext,
  type Tx,
} from '../database/index.js';
import { GrantDirectory, PersonDirectory } from '../identity/index.js';
import {
  SOCIETY_SORT_FIELDS,
  type CreateSocietyDto,
  type ListSocietiesQueryDto,
  type PauseSocietyDto,
  type UpdateSocietyDto,
} from './society.dto.js';
import { SocietyRepository, type SocietyChanges, type SocietyRow } from './society.repository.js';
import {
  institutionsOf,
  peopleOf,
  societyResource,
  societySummary,
  type SocietyDetail,
  type SocietyResource,
  type SocietySummary,
} from './society.resource.js';
import type { VersionDto } from '../../common/validation/version.dto.js';

/** Why the grants of a deactivated Society were revoked; a reactivation can find them by it. */
export const SOCIETY_DEACTIVATED = 'society_deactivated';

type Profile = Partial<Omit<CreateSocietyDto, 'name' | 'code'>>;

/** The columns a request's profile fields set. An omitted field is left out; `null` clears it. */
function profileColumns(profile: Profile): SocietyChanges {
  const columns: SocietyChanges = {};
  if (profile.description !== undefined) columns.description = profile.description;
  if (profile.email !== undefined) columns.email = profile.email?.toLowerCase() ?? null;
  if (profile.phone !== undefined) {
    columns.country_code = profile.phone?.countryCode ?? null;
    columns.phone_number = profile.phone?.number ?? null;
  }
  if (profile.website !== undefined) columns.website = profile.website;
  if (profile.foundedDate !== undefined) columns.founded_date = profile.foundedDate;
  if (profile.address !== undefined) {
    // The address is replaced as a whole (API design 10.4b).
    columns.address_line_1 = profile.address?.line1 ?? null;
    columns.address_line_2 = profile.address?.line2 ?? null;
    columns.pincode = profile.address?.pincode ?? null;
  }
  return columns;
}

/** What the audit log keeps of a Society: its own fields, nothing derived. */
function auditView(row: SocietyRow): AuditValues {
  return {
    name: row.name,
    code: row.code,
    description: row.description,
    email: row.email,
    country_code: row.country_code,
    phone_number: row.phone_number,
    website: row.website,
    founded_date: row.founded_date,
    address_line_1: row.address_line_1,
    address_line_2: row.address_line_2,
    pincode: row.pincode,
    status: row.status,
  };
}

/**
 * Super Admin reaches these tables as a platform operator (DDD 15.3). A change
 * names its Society too: the audit entry carries the Society's ID so its owners
 * see it (API design 20.3), and the audit policy admits only the Society the
 * request is acting in.
 */
function platformTenant(principal: Principal, societyId?: string): TenantContext {
  return { personId: principal.personId, roleCode: RoleCode.SuperAdmin, societyId };
}

function isDuplicateCode(error: unknown): boolean {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return (
    code === PgErrorCode.uniqueViolation &&
    typeof constraint === 'string' &&
    constraint.startsWith('uq_societies_code')
  );
}

function duplicateCode(): AppException {
  const language = RequestContext.current()?.language;
  return new AppException(HttpStatus.CONFLICT, ErrorCode.DUPLICATE, {
    errors: [
      {
        field: 'code',
        code: ErrorCode.DUPLICATE,
        message: message(ErrorCode.DUPLICATE, language),
      },
    ],
  });
}

/**
 * PLT-02 to PLT-08 (API design 10.4b): Super Admin looks after Societies. Every
 * change runs in one transaction with its audit entry, and the row is locked
 * for the check of `version` and state, so two admins cannot both win.
 */
@Injectable()
export class SocietyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly societies: SocietyRepository,
    private readonly people: PersonDirectory,
    private readonly grants: GrantDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(
    principal: Principal,
    query: ListSocietiesQueryDto,
  ): Promise<ApiResult<SocietySummary[]>> {
    const sort = parseSort(query.sort, SOCIETY_SORT_FIELDS, [{ field: 'name', direction: 'asc' }]);
    const { rows, total } = await this.database.transaction(platformTenant(principal), (tx) =>
      this.societies.page(
        tx,
        { q: query.q, statuses: query.status, paused: query.paused },
        sort,
        query.limit,
        pageOffset(query.page, query.limit),
      ),
    );
    const people = await this.people.describe(peopleOf(rows));
    return ApiResult.list(
      rows.map((row) => societySummary(row, people)),
      pageMeta(query.page, query.limit, total),
    );
  }

  async get(principal: Principal, id: string): Promise<SocietyDetail> {
    const { row, institutions } = await this.database.transaction(
      platformTenant(principal),
      async (tx) => {
        const found = await this.societies.find(tx, id);
        if (!found) throw AppException.notFound();
        return { row: found, institutions: await this.societies.institutions(tx, id) };
      },
    );
    const owners = await this.grants.societyOwners(id);
    return {
      ...(await this.resource(row)),
      institutions: institutionsOf(institutions),
      owners,
    };
  }

  async create(principal: Principal, body: CreateSocietyDto): Promise<SocietyResource> {
    const id = newId();
    const row = await this.database
      .transaction(platformTenant(principal, id), async (tx) => {
        await this.societies.insert(tx, {
          id,
          name: body.name,
          code: body.code,
          ...profileColumns(body),
          ...insertStamp(principal.personId),
        });
        const created = await this.mustFind(tx, id);
        await this.record(tx, 'society.create', created, { after: auditView(created) });
        return created;
      })
      .catch((error: unknown) => {
        throw isDuplicateCode(error) ? duplicateCode() : error;
      });
    return this.resource(row);
  }

  async update(principal: Principal, id: string, body: UpdateSocietyDto): Promise<SocietyResource> {
    const row = await this.database.transaction(platformTenant(principal, id), async (tx) => {
      const current = await this.lockedAt(tx, id, body.version);
      this.requireActive(current);
      const wanted: SocietyChanges = {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...profileColumns(body),
      };
      // A request that changes nothing writes nothing: no new version, no audit entry.
      const changes = Object.fromEntries(
        Object.entries(wanted).filter(
          ([column, value]) => current[column as keyof SocietyRow] !== value,
        ),
      ) as SocietyChanges;
      if (Object.keys(changes).length === 0) return current;
      await this.societies.update(tx, id, { ...changes, ...updateStamp(principal.personId) });
      const updated = await this.mustFind(tx, id);
      await this.record(tx, 'society.update', updated, {
        before: auditView(current),
        after: auditView(updated),
      });
      return updated;
    });
    return this.resource(row);
  }

  /** Deactivates; the Society's people lose access at once (see `GrantDirectory.endAccessInSociety`). */
  async deactivate(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    await this.database.transaction(platformTenant(principal, id), async (tx) => {
      const current = await this.societies.find(tx, id, true);
      if (!current) throw AppException.notFound();
      this.requireActive(current);
      await this.societies.update(tx, id, { status: 0, ...updateStamp(principal.personId) });
      const ended = await this.grants.endAccessInSociety(
        tx,
        id,
        principal.personId,
        SOCIETY_DEACTIVATED,
        this.clock.now(),
      );
      await this.record(tx, 'society.deactivate', current, {
        before: { status: 1 },
        after: { status: 0, ...ended },
      });
    });
    return { id, status: 0 };
  }

  async pause(principal: Principal, id: string, body: PauseSocietyDto): Promise<SocietyResource> {
    const row = await this.database.transaction(platformTenant(principal, id), async (tx) => {
      const current = await this.lockedAt(tx, id, body.version);
      this.requireActive(current);
      if (current.access_paused_at !== null) throw AppException.conflict(ErrorCode.INVALID_STATE);
      const pausedAt = this.clock.now();
      await this.societies.update(tx, id, {
        access_paused_at: pausedAt,
        access_paused_by: principal.personId,
        access_pause_reason: body.reason,
        ...updateStamp(principal.personId),
      });
      const paused = await this.mustFind(tx, id);
      await this.record(tx, 'access.pause', paused, {
        reason: body.reason,
        before: { access_paused: false },
        after: { access_paused: true },
      });
      return paused;
    });
    return this.resource(row);
  }

  async resume(principal: Principal, id: string, body: VersionDto): Promise<SocietyResource> {
    const row = await this.database.transaction(platformTenant(principal, id), async (tx) => {
      const current = await this.lockedAt(tx, id, body.version);
      if (current.access_paused_at === null) throw AppException.conflict(ErrorCode.INVALID_STATE);
      await this.societies.update(tx, id, {
        access_paused_at: null,
        access_paused_by: null,
        access_pause_reason: null,
        ...updateStamp(principal.personId),
      });
      const resumed = await this.mustFind(tx, id);
      await this.record(tx, 'access.resume', resumed, {
        before: { access_paused: true },
        after: { access_paused: false },
      });
      return resumed;
    });
    return this.resource(row);
  }

  /** The row, locked, for a change that names the `version` the client read. */
  private async lockedAt(tx: Tx, id: string, version: number): Promise<SocietyRow> {
    const row = await this.societies.find(tx, id, true);
    if (!row) throw AppException.notFound();
    if (row.version !== version) throw AppException.versionConflict(row.version);
    return row;
  }

  private async mustFind(tx: Tx, id: string): Promise<SocietyRow> {
    const row = await this.societies.find(tx, id);
    if (!row) throw AppException.notFound();
    return row;
  }

  /** A deactivated Society keeps its records but takes no more changes. */
  private requireActive(row: SocietyRow): void {
    if (row.status !== 1) throw AppException.conflict(ErrorCode.INVALID_STATE);
  }

  private async resource(row: SocietyRow): Promise<SocietyResource> {
    return societyResource(row, await this.people.describe(peopleOf([row])));
  }

  /** The audit entry carries the Society's ID, so its owners see it in AUD-01 (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    society: SocietyRow,
    values: { reason?: string; before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: null,
      societyId: society.id,
      entityType: 'society',
      entityId: society.id,
      ...values,
    });
  }
}
