import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/index.js';

/**
 * What the Identity module tells other modules about a person's grants. The
 * `role_assignments` table stays private to Identity (SDD 9.3 rule 1).
 */
@Injectable()
export class GrantDirectory {
  constructor(private readonly database: DatabaseService) {}

  /** The Institutions an Institution Admin holds an active grant for in one Society. */
  async adminInstitutionIds(userId: string, societyId: string): Promise<string[]> {
    const rows = await this.database.db
      .selectFrom('role_assignments')
      .select('institution_id')
      .where('user_id', '=', userId)
      .where('role_code', '=', 3)
      .where('society_id', '=', societyId)
      .where('revoked_at', 'is', null)
      .execute();
    return rows.flatMap((row) => (row.institution_id === null ? [] : [row.institution_id]));
  }
}
