import { Injectable } from '@nestjs/common';
import { sql, type ExpressionBuilder } from 'kysely';
import { containsPattern, type SortKey } from '../../common/pagination/pagination.js';
import { DatabaseService, type Database, type Tx } from '../database/index.js';
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
      .orderBy('grant.seat_no')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: personName(row.first_name, row.last_name) ?? row.email,
      accountStatus: reportedStatus(row.account_status),
    }));
  }

  /**
   * Every active Society Owner grant, a page at a time (PLT-11). `q` matches the
   * person's name or email, ignoring case.
   */
  async ownersPage(
    filter: { q?: string; societyId?: string },
    sort: readonly SortKey<OwnerSortField>[],
    limit: number,
    offset: number,
  ): Promise<{ rows: OwnerGrant[]; total: number }> {
    const matching = (eb: ExpressionBuilder<Database, 'role_assignments' | 'users'>) => {
      const conditions = [
        eb('role_assignments.role_code', '=', 2),
        eb('role_assignments.revoked_at', 'is', null),
      ];
      if (filter.societyId)
        conditions.push(eb('role_assignments.society_id', '=', filter.societyId));
      if (filter.q) {
        const pattern = containsPattern(filter.q);
        conditions.push(
          eb.or([
            eb('users.email', 'ilike', pattern),
            sql<boolean>`${DISPLAY_NAME} ilike ${pattern}`,
          ]),
        );
      }
      return eb.and(conditions);
    };
    const base = () =>
      this.database.db
        .selectFrom('role_assignments')
        .innerJoin('users', 'users.id', 'role_assignments.user_id')
        .where(matching);
    let query = base().select([
      'users.id',
      'users.email',
      'users.first_name',
      'users.last_name',
      'users.account_status',
      'users.blocked_at',
      'users.block_reason',
      'users.version',
      'role_assignments.society_id',
      'role_assignments.seat_no',
      'role_assignments.created_at as granted_at',
    ]);
    for (const key of sort) query = query.orderBy(OWNER_SORT_COLUMN[key.field], key.direction);
    const rows = await query.orderBy('role_assignments.id').limit(limit).offset(offset).execute();
    const { total } = await base()
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
    return {
      rows: rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: personName(row.first_name, row.last_name) ?? row.email,
        accountStatus: reportedStatus(row.account_status),
        blockedAt: row.blocked_at,
        blockReason: row.block_reason,
        version: row.version,
        societyId: row.society_id!,
        seatNo: row.seat_no!,
        grantedAt: row.granted_at,
      })),
      total,
    };
  }

  /**
   * An Institution was deactivated: the Institution Admin grants for it are
   * revoked. An Admin left with no other grant in the Society loses the role on
   * their next call (the per-request check asks for a grant in the Society); one
   * with another Institution keeps working there. Runs in the caller's
   * transaction. Returns how many grants ended.
   */
  async endAdminAccessInInstitution(
    tx: Tx,
    institutionId: string,
    by: string | null,
    reason: string,
    now: Date,
  ): Promise<number> {
    const grants = await tx
      .updateTable('role_assignments')
      .set({ revoked_at: now, revoked_by: by, revoke_reason: reason })
      .where('institution_id', '=', institutionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(grants.numUpdatedRows);
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

/** The person's name as lists show it: first and last name, else the email. */
const DISPLAY_NAME = sql`coalesce(nullif(btrim(concat_ws(' ', users.first_name, users.last_name)), ''), users.email)`;

export type OwnerSortField = 'name' | 'email' | 'createdAt';
export const OWNER_SORT_FIELDS = ['name', 'email', 'createdAt'] as const;

const OWNER_SORT_COLUMN = {
  name: sql`lower(${DISPLAY_NAME})`,
  email: sql`users.email`,
  createdAt: sql`role_assignments.created_at`,
} as const;

/** One Owner seat, as PLT-11 lists it; the Society is named by its ID. */
export interface OwnerGrant extends SocietyOwner {
  /** What PLT-15 to PLT-17 need to act on the person: their account's block state and version. */
  blockedAt: Date | null;
  blockReason: string | null;
  version: number;
  societyId: string;
  seatNo: number;
  grantedAt: Date;
}

export interface SocietyOwner {
  id: string;
  email: string;
  displayName: string;
  accountStatus: number;
}
