import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService, type TenantContext } from '../database/index.js';
import type { ActiveBlock } from './access-block.rules.js';

/**
 * Reads of the tenant roots. Every read runs inside a transaction that sets the
 * caller's tenant, so row-level security applies exactly as it will to the
 * module's later endpoints: a row the caller may not see comes back as absent.
 */
@Injectable()
export class TenancyRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * The blocks in force in a Society the person holds a grant in. A block is a
   * row that has to exist to stop someone, so this does not go through
   * row-level security, which would hide it from the very caller it should stop.
   */
  async activeBlocks(societyId: string, personId: string): Promise<ActiveBlock[]> {
    const { rows } = await sql<{
      section: number;
      institution_id: string | null;
    }>`select section, institution_id from app_active_blocks(${societyId}::uuid, ${personId}::uuid)`.execute(
      this.database.db,
    );
    return rows.map((row) => ({
      section: row.section as ActiveBlock['section'],
      institutionId: row.institution_id,
    }));
  }

  /**
   * The IDs of the active Institutions of a Society, optionally only among `ids`.
   * Deactivated Institutions are left out: their records answer 404 (API design 6.5).
   */
  async activeInstitutionIds(
    tenant: TenantContext,
    societyId: string,
    ids: readonly string[] | null,
  ): Promise<string[]> {
    if (ids?.length === 0) return [];
    const rows = await this.database.transaction(tenant, (tx) => {
      let query = tx
        .selectFrom('institutions')
        .select('id')
        .where('society_id', '=', societyId)
        .where('status', '=', 1);
      if (ids) query = query.where('id', 'in', ids);
      return query.orderBy('id').execute();
    });
    return rows.map((row) => row.id);
  }
}
