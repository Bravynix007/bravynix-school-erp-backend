import { Injectable } from '@nestjs/common';
import { DatabaseService, type TenantContext } from '../database/index.js';

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
   * Whether the Institution, or the Society that runs it, is paused. `null`
   * when the Institution is not visible to this caller.
   */
  async institutionPauseState(
    tenant: TenantContext,
    institutionId: string,
  ): Promise<boolean | null> {
    const row = await this.database.transaction(tenant, (tx) =>
      tx
        .selectFrom('institutions as i')
        .innerJoin('societies as s', 's.id', 'i.society_id')
        .select([
          'i.access_paused_at as institutionPausedAt',
          's.access_paused_at as societyPausedAt',
        ])
        .where('i.id', '=', institutionId)
        .executeTakeFirst(),
    );
    return row ? row.institutionPausedAt !== null || row.societyPausedAt !== null : null;
  }
}
