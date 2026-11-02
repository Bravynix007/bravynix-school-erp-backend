import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { requireVersion } from '../../common/http/require-version.js';
import { AuditService, type AuditValues } from '../audit/index.js';
import {
  DatabaseService,
  duplicateOn,
  insertStamp,
  isDuplicateOn,
  platformTenant,
  updateStamp,
  type Tx,
} from '../database/index.js';
import type { MasterQueryDto } from './master.dto.js';
import { parseMasterBody } from './master-body.js';
import type { MasterSpec } from './master.catalog.js';
import { MasterReferences } from './master-references.js';
import { MasterRepository } from './master.repository.js';
import { listEtag, masterEntry, type MasterEntry, type MasterRow } from './master.resource.js';
import { listFilters, planInsert, planMove } from './master.rules.js';

/** How long a signed-in person's app may keep a list without asking again (SDD 14.2). */
const MAX_AGE_SECONDS = 300;

/** What the audit log keeps of an entry: its fields and whether it is shown. */
function auditView(spec: MasterSpec, row: MasterRow): AuditValues {
  const view: AuditValues = { status: row.status };
  for (const { column } of spec.fields) view[column] = row[column];
  return view;
}

/** The columns a body sets: the fields it names, with `null` clearing an optional one. */
function columnsOf(spec: MasterSpec, body: Record<string, unknown>): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  for (const { api, column } of spec.fields) {
    if (api !== 'displayOrder' && body[api] !== undefined) columns[column] = body[api];
  }
  return columns;
}

/**
 * MST-01 and PLT-31 to PLT-33 (API design 10.4g): the platform masters. Everyone signed in reads the
 * shown entries; Super Admin also reads the hidden ones and adds, edits, moves, hides and shows. An
 * entry is never deleted, because other records point at it. Each change commits with its audit entry.
 */
@Injectable()
export class MasterService {
  constructor(
    private readonly database: DatabaseService,
    private readonly masters: MasterRepository,
    private readonly references: MasterReferences,
    private readonly audit: AuditService,
  ) {}

  /**
   * MST-01. The `ETag` set here is what lets a list be revalidated with `If-None-Match`: Express answers
   * 304 with no body when it matches (weak comparison, and `*`), so nothing is compared in this service. Super
   * Admin asking for hidden entries is managing the list, so it is never served from a cache without
   * asking; everyone else may keep it five minutes.
   */
  async list(
    principal: Principal,
    spec: MasterSpec,
    query: MasterQueryDto,
  ): Promise<ApiResult<MasterEntry[]>> {
    const includeHidden = query.includeHidden ?? false;
    if (includeHidden && principal.roleCode !== RoleCode.SuperAdmin) throw AppException.forbidden();
    const filters = listFilters(spec, query as Record<string, unknown>);
    const rows = await this.database.transaction(
      {
        personId: principal.personId,
        roleCode: principal.roleCode,
        societyId: principal.societyId,
      },
      (tx) => this.masters.list(tx, spec, { includeHidden, filters }),
    );
    const entries = rows.map((row) => masterEntry(spec, row));
    const etag = listEtag(entries);
    const headers = {
      ETag: etag,
      'Cache-Control': includeHidden ? 'private, no-cache' : `private, max-age=${MAX_AGE_SECONDS}`,
      Vary: 'Authorization',
    };
    return new ApiResult(entries, { status: HttpStatus.OK, headers });
  }

  /**
   * PLT-31: a new entry, last in its list or at `displayOrder` (the entries from there on move down one).
   * 404 for a parent that does not exist, 422 `REFERENCE_INACTIVE` for one that is hidden, 409
   * `DUPLICATE` with the field for a code, ISO code or name already taken.
   */
  async create(principal: Principal, spec: MasterSpec, raw: unknown): Promise<MasterEntry> {
    const body = (await parseMasterBody(spec.create, raw)) as Record<string, unknown>;
    const row = await this.database
      .transaction(platformTenant(principal), async (tx) => {
        if (spec.ordered) await this.masters.lockList(tx, spec);
        await this.requireParent(tx, spec, body);
        const values: Record<string, unknown> = {
          ...columnsOf(spec, body),
          ...insertStamp(principal.personId),
        };
        if (spec.ordered) {
          const plan = planInsert(
            body.displayOrder as number | undefined,
            await this.masters.count(tx, spec),
          );
          if (plan.shift) {
            await this.masters.shift(tx, spec, plan.shift.range, plan.shift.by, principal.personId);
          }
          values.display_order = plan.position;
        }
        const created = await this.masters.insert(tx, spec, values);
        await this.record(tx, 'platform.master.created', spec, created, {
          after: auditView(spec, created),
        });
        return created;
      })
      .catch((error: unknown) => {
        throw this.translate(spec, error);
      });
    return masterEntry(spec, row);
  }

  /**
   * PLT-32: `version` is checked first (409 `VERSION_CONFLICT`). A request that changes nothing writes
   * nothing: no new version, no audit entry. `displayOrder` moves the entry and the ones it passes.
   */
  async update(
    principal: Principal,
    spec: MasterSpec,
    id: string,
    raw: unknown,
  ): Promise<MasterEntry> {
    const body = (await parseMasterBody(spec.update, raw)) as Record<string, unknown> & {
      version: number;
    };
    const row = await this.database
      .transaction(platformTenant(principal), async (tx) => {
        if (spec.ordered) await this.masters.lockList(tx, spec);
        const current = await this.mustFind(tx, spec, id);
        requireVersion(current, body.version);
        const changes: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(columnsOf(spec, body))) {
          if (current[column] !== value) changes[column] = value;
        }
        if (body.status !== undefined && body.status !== current.status) {
          changes.status = body.status;
        }
        if (spec.ordered && body.displayOrder !== undefined) {
          const shift = planMove(
            current.display_order as number,
            body.displayOrder as number,
            await this.masters.count(tx, spec),
          );
          if (shift) {
            await this.masters.shift(tx, spec, shift.range, shift.by, principal.personId);
            changes.display_order = body.displayOrder;
          }
        }
        if (Object.keys(changes).length === 0) return current;
        const updated = await this.masters.update(tx, spec, id, {
          ...changes,
          ...updateStamp(principal.personId),
        });
        const statusOnly = Object.keys(changes).length === 1 && 'status' in changes;
        const action = !statusOnly
          ? 'platform.master.updated'
          : updated.status === 0
            ? 'platform.master.hidden'
            : 'platform.master.shown';
        await this.record(tx, action, spec, updated, {
          before: auditView(spec, current),
          after: auditView(spec, updated),
        });
        return updated;
      })
      .catch((error: unknown) => {
        throw this.translate(spec, error);
      });
    return masterEntry(spec, row);
  }

  /** PLT-33: hides the entry from pickers; rows other records point at are never deleted. 409 `INVALID_STATE` when already hidden. */
  async hide(
    principal: Principal,
    spec: MasterSpec,
    id: string,
  ): Promise<{ id: string; status: 0 }> {
    await this.database.transaction(platformTenant(principal), async (tx) => {
      if (spec.ordered) await this.masters.lockList(tx, spec);
      const current = await this.mustFind(tx, spec, id);
      if (current.status === 0) throw AppException.conflict(ErrorCode.INVALID_STATE);
      const updated = await this.masters.update(tx, spec, id, {
        status: 0,
        ...updateStamp(principal.personId),
      });
      await this.record(tx, 'platform.master.hidden', spec, updated, {
        before: auditView(spec, current),
        after: auditView(spec, updated),
      });
    });
    return { id, status: 0 };
  }

  private async mustFind(tx: Tx, spec: MasterSpec, id: string): Promise<MasterRow> {
    const row = await this.masters.find(tx, spec, id, true);
    if (!row) throw AppException.notFound();
    return row;
  }

  /** A new entry points at a parent that exists (404) and is shown (422 `REFERENCE_INACTIVE`, naming the field). */
  private async requireParent(
    tx: Tx,
    spec: MasterSpec,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!spec.parent) return;
    await this.references.requireShown(
      tx,
      spec.parent.table,
      body[spec.parent.field] as string,
      spec.parent.field,
    );
  }

  /** A unique violation becomes 409 `DUPLICATE` on the field it protects. */
  private translate(spec: MasterSpec, error: unknown): unknown {
    const taken = spec.duplicates.find(({ constraint }) => isDuplicateOn(error, constraint));
    return taken ? duplicateOn(taken.field) : error;
  }

  /** Masters belong to no Society, so the entry carries none: it is a platform action (API design 20.3). */
  private record(
    tx: Tx,
    action: string,
    spec: MasterSpec,
    row: MasterRow,
    values: { before?: AuditValues; after?: AuditValues },
  ): Promise<string> {
    return this.audit.record(tx, {
      action,
      institutionId: null,
      societyId: null,
      entityType: spec.entity,
      entityId: row.id,
      ...values,
    });
  }
}
