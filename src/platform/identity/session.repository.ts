import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Db, Tx } from '../database/index.js';

/** One active grant: a role, in a Society for roles 2 and 3, in an Institution for role 3. */
export interface Grant {
  roleCode: number;
  societyId: string | null;
  societyName: string | null;
  institutionId: string | null;
  /** The Society's Owners are blocked (section `owners`). */
  ownersBlocked: boolean;
  /** The grant's Institution has its staff blocked (section `staff`). */
  staffBlocked: boolean;
}

export interface NewSession {
  id: string;
  userId: string;
  clientType: number;
  activeRoleCode: number | null;
  activeSocietyId: string | null;
  now: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  deviceLabel: string | null;
}

/** A session with its person's account status, as the per-request check and refresh read it. */
export interface SessionRow {
  id: string;
  userId: string;
  clientType: number;
  activeRoleCode: number | null;
  activeSocietyId: string | null;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date | null;
  endedAt: Date | null;
  endReason: number | null;
  accountStatus: number;
}

/** A refresh token with its session, read with the token row locked. */
export interface LockedRefreshToken {
  tokenId: string;
  expiresAt: Date;
  usedAt: Date | null;
  session: SessionRow;
}

const SESSION_COLUMNS = [
  's.id',
  's.user_id',
  's.client_type',
  's.active_role_code',
  's.active_society_id',
  's.last_used_at',
  's.idle_expires_at',
  's.absolute_expires_at',
  's.ended_at',
  's.end_reason',
  'u.account_status',
] as const;

function toSession(row: {
  id: string;
  user_id: string;
  client_type: number;
  active_role_code: number | null;
  active_society_id: string | null;
  last_used_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date | null;
  ended_at: Date | null;
  end_reason: number | null;
  account_status: number;
}): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    clientType: row.client_type,
    activeRoleCode: row.active_role_code,
    activeSocietyId: row.active_society_id,
    lastUsedAt: row.last_used_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    accountStatus: row.account_status,
  };
}

/** Sessions and refresh tokens (DDD 9.1). Only the Identity module touches these tables. */
@Injectable()
export class SessionRepository {
  /** The grants that let this person act as Super Admin, Owner or Institution Admin. */
  async activeGrants(tx: Db, userId: string): Promise<Grant[]> {
    // Sign-in has no role set, so row-level security hides every Society and block; the
    // functions hand back the one name, and the active blocks, of a Society the person
    // holds a grant in.
    const rows = await tx
      .selectFrom('role_assignments')
      .select([
        'role_code',
        'society_id',
        'institution_id',
        sql<
          string | null
        >`app_society_name(role_assignments.society_id, role_assignments.user_id)`.as(
          'society_name',
        ),
        sql<boolean>`exists (
          select 1 from app_active_blocks(role_assignments.society_id, role_assignments.user_id) b
          where b.section = 1
        )`.as('owners_blocked'),
        sql<boolean>`exists (
          select 1 from app_active_blocks(role_assignments.society_id, role_assignments.user_id) b
          where b.section = 2 and b.institution_id = role_assignments.institution_id
        )`.as('staff_blocked'),
      ])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .orderBy('role_code')
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({
      roleCode: row.role_code,
      societyId: row.society_id,
      societyName: row.society_name,
      institutionId: row.institution_id,
      ownersBlocked: row.owners_blocked,
      staffBlocked: row.staff_blocked,
    }));
  }

  async createSession(tx: Tx, session: NewSession): Promise<void> {
    await sql`
      insert into auth_sessions
        (id, created_at, user_id, client_type, active_role_code, active_society_id, last_used_at,
         idle_expires_at, absolute_expires_at, ip_address, user_agent, device_label)
      values (
        ${session.id}, ${session.now}, ${session.userId}, ${session.clientType},
        ${session.activeRoleCode}, ${session.activeSocietyId}, ${session.now},
        ${session.idleExpiresAt}, ${session.absoluteExpiresAt}, ${session.ip}::inet,
        ${session.userAgent}, ${session.deviceLabel}
      )`.execute(tx);
  }

  async insertRefreshToken(
    tx: Tx,
    token: { id: string; sessionId: string; hmac: Buffer; expiresAt: Date; now: Date },
  ): Promise<void> {
    await tx
      .insertInto('refresh_tokens')
      .values({
        id: token.id,
        created_at: token.now,
        session_id: token.sessionId,
        token_hmac: token.hmac,
        expires_at: token.expiresAt,
        used_at: null,
      })
      .execute();
  }

  async findSession(db: Db, sessionId: string): Promise<SessionRow | undefined> {
    const row = await db
      .selectFrom('auth_sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select(SESSION_COLUMNS)
      .where('s.id', '=', sessionId)
      .executeTakeFirst();
    return row && toSession(row);
  }

  /**
   * Finds the refresh token by its hash and locks the token row until the
   * transaction ends, so two refreshes with one token run one after the other
   * and the second sees the first's `used_at` (API design 10.3).
   */
  async lockRefreshToken(tx: Tx, hmac: Buffer): Promise<LockedRefreshToken | undefined> {
    const row = await tx
      .selectFrom('refresh_tokens as t')
      .innerJoin('auth_sessions as s', 's.id', 't.session_id')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select([...SESSION_COLUMNS, 't.id as token_id', 't.expires_at', 't.used_at'])
      .where('t.token_hmac', '=', hmac)
      .forUpdate('t')
      .executeTakeFirst();
    return (
      row && {
        tokenId: row.token_id,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        session: toSession(row),
      }
    );
  }

  async markTokenUsed(tx: Tx, tokenId: string, now: Date): Promise<void> {
    await tx
      .updateTable('refresh_tokens')
      .set({ used_at: now })
      .where('id', '=', tokenId)
      .execute();
  }

  /** Moves a session's idle deadline forward on use. */
  async touchSession(db: Db, sessionId: string, now: Date, idleExpiresAt: Date): Promise<void> {
    await db
      .updateTable('auth_sessions')
      .set({ last_used_at: now, idle_expires_at: idleExpiresAt })
      .where('id', '=', sessionId)
      .where('ended_at', 'is', null)
      .execute();
  }

  /** The role and Society the session acts as from now on. */
  async setActiveContext(
    db: Db,
    sessionId: string,
    roleCode: number,
    societyId: string | null,
  ): Promise<boolean> {
    const result = await db
      .updateTable('auth_sessions')
      .set({ active_role_code: roleCode, active_society_id: societyId })
      .where('id', '=', sessionId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Ends one session; a session that has already ended keeps its first reason. */
  async endSession(db: Db, sessionId: string, reason: number, now: Date): Promise<boolean> {
    const result = await db
      .updateTable('auth_sessions')
      .set({ ended_at: now, end_reason: reason })
      .where('id', '=', sessionId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Ends every open session of a person, or all but `exceptSessionId`. Returns how many ended. */
  async endUserSessions(
    db: Db,
    userId: string,
    reason: number,
    now: Date,
    exceptSessionId?: string,
  ): Promise<number> {
    let query = db
      .updateTable('auth_sessions')
      .set({ ended_at: now, end_reason: reason })
      .where('user_id', '=', userId)
      .where('ended_at', 'is', null);
    if (exceptSessionId) query = query.where('id', '<>', exceptSessionId);
    return Number((await query.executeTakeFirst()).numUpdatedRows);
  }

  /** Is this role still granted to the person, in this Society for roles 2 and 3? */
  async hasGrant(
    db: Db,
    userId: string,
    roleCode: number,
    societyId: string | null,
  ): Promise<boolean> {
    let query = db
      .selectFrom('role_assignments')
      .select('id')
      .where('user_id', '=', userId)
      .where('role_code', '=', roleCode)
      .where('revoked_at', 'is', null);
    query =
      societyId === null
        ? query.where('society_id', 'is', null)
        : query.where('society_id', '=', societyId);
    return (await query.executeTakeFirst()) !== undefined;
  }
}
