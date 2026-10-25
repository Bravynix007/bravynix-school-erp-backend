import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../database/index.js';

/** One active grant: a role, in a Society for roles 2 and 3, in an Institution for role 3. */
export interface Grant {
  roleCode: number;
  societyId: string | null;
  institutionId: string | null;
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

/** Sessions and refresh tokens (DDD 9.1). Only the Identity module touches these tables. */
@Injectable()
export class SessionRepository {
  /** The grants that let this person act as Super Admin, Owner or Institution Admin. */
  async activeGrants(tx: Tx, userId: string): Promise<Grant[]> {
    const rows = await tx
      .selectFrom('role_assignments')
      .select(['role_code', 'society_id', 'institution_id'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .orderBy('role_code')
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({
      roleCode: row.role_code,
      societyId: row.society_id,
      institutionId: row.institution_id,
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
}
