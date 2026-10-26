import { Injectable } from '@nestjs/common';
import { DatabaseService, type Tx } from '../database/index.js';
import { reportedStatus, SessionEndReason } from './auth-codes.js';
import { personName } from './person-name.js';

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

  /** The people with an active Society Owner grant in a Society, by name. */
  async societyOwners(societyId: string): Promise<SocietyOwner[]> {
    const rows = await this.database.db
      .selectFrom('role_assignments as grant')
      .innerJoin('users', 'users.id', 'grant.user_id')
      .select([
        'users.id',
        'users.email',
        'users.first_name',
        'users.last_name',
        'users.account_status',
      ])
      .where('grant.role_code', '=', 2)
      .where('grant.society_id', '=', societyId)
      .where('grant.revoked_at', 'is', null)
      .orderBy('grant.created_at')
      .orderBy('grant.id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: personName(row.first_name, row.last_name) ?? row.email,
      accountStatus: reportedStatus(row.account_status),
    }));
  }

  /**
   * A Society was deactivated: every grant in it is revoked, so none counts at
   * sign-in or in the context list, and every open session acting in it ends
   * with `admin_revoked`, whatever the role (API design 10.4b). Runs in the
   * caller's transaction, so the deactivation and its effect commit together.
   * The grants keep their revoke reason, so a later reactivation can restore them.
   */
  async endAccessInSociety(
    tx: Tx,
    societyId: string,
    by: string | null,
    reason: string,
    now: Date,
  ): Promise<{ grantsRevoked: number; sessionsEnded: number }> {
    const grants = await tx
      .updateTable('role_assignments')
      .set({ revoked_at: now, revoked_by: by, revoke_reason: reason })
      .where('society_id', '=', societyId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const sessions = await tx
      .updateTable('auth_sessions')
      .set({ ended_at: now, end_reason: SessionEndReason.AccessRevoked })
      .where('active_society_id', '=', societyId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return {
      grantsRevoked: Number(grants.numUpdatedRows),
      sessionsEnded: Number(sessions.numUpdatedRows),
    };
  }
}

export interface SocietyOwner {
  id: string;
  email: string;
  displayName: string;
  accountStatus: number;
}
