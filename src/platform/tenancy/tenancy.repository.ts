import { Injectable } from '@nestjs/common';
import { DatabaseService, type TenantContext } from '../database/index.js';

export interface ScopedInstitution {
  id: string;
  paused: boolean;
}

/**
 * Reads of the tenant roots. Every read runs inside a transaction that sets the
 * caller's tenant, so row-level security applies exactly as it will to the
 * module's later endpoints: a row the caller may not see comes back as absent.
 */
@Injectable()
export class TenancyRepository {
  constructor(private readonly database: DatabaseService) {}

  /** `null` when the Society is not visible to this caller. */
  async societyPauseState(tenant: TenantContext, societyId: string): Promise<boolean | null> {
    const row = await this.database.transaction(tenant, (tx) =>
      tx
        .selectFrom('societies')
        .select('access_paused_at')
        .where('id', '=', societyId)
        .executeTakeFirst(),
    );
    return row ? row.access_paused_at !== null : null;
  }

  /**
   * The active Institutions of a Society, optionally only among `ids`, with
   * whether each is paused. Deactivated Institutions are left out: their
   * records answer 404 (API design 6.5).
   */
  async activeInstitutions(
    tenant: TenantContext,
    societyId: string,
    ids: readonly string[] | null,
  ): Promise<ScopedInstitution[]> {
    if (ids?.length === 0) return [];
    const rows = await this.database.transaction(tenant, (tx) => {
      let query = tx
        .selectFrom('institutions')
        .select(['id', 'access_paused_at'])
        .where('society_id', '=', societyId)
        .where('status', '=', 1);
      if (ids) query = query.where('id', 'in', ids);
      return query.orderBy('id').execute();
    });
    return rows.map((row) => ({ id: row.id, paused: row.access_paused_at !== null }));
  }
}
