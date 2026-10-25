import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId } from '../../common/ids/ids.js';
import type { Tx } from '../database/index.js';
import { AccountStatus } from './auth-codes.js';

export interface LoginUser {
  id: string;
  accountStatus: number;
  preferredLanguage: string;
  lockedUntil: Date | null;
}

export interface NewChallenge {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  emailHmac: Buffer;
  userId: string | null;
  codeHmac: Buffer | null;
  requestIp: string | null;
}

/**
 * The Identity module's own queries. Nothing outside the module touches
 * these tables (DDD 15.3, SDD 9.3 rule 1).
 */
@Injectable()
export class IdentityRepository {
  async findUserByEmail(tx: Tx, email: string): Promise<LoginUser | undefined> {
    const row = await tx
      .selectFrom('users')
      .select(['id', 'account_status', 'preferred_language', 'locked_until'])
      .where('email', '=', email)
      .executeTakeFirst();
    return (
      row && {
        id: row.id,
        accountStatus: row.account_status,
        preferredLanguage: row.preferred_language,
        lockedUntil: row.locked_until,
      }
    );
  }

  async hasActiveSuperAdminGrant(tx: Tx, userId: string): Promise<boolean> {
    const row = await tx
      .selectFrom('role_assignments')
      .select('id')
      .where('user_id', '=', userId)
      .where('role_code', '=', 1)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * One request at a time per email, so two parallel requests cannot both pass
   * the limits. Does not wait: false means another request for this email is
   * running right now.
   */
  async tryLockEmail(tx: Tx, emailHmac: Buffer): Promise<boolean> {
    const { rows } = await sql<{
      locked: boolean;
    }>`select pg_try_advisory_xact_lock(hashtextextended(${emailHmac.toString('hex')}, 0)) as locked`.execute(
      tx,
    );
    return rows[0]?.locked === true;
  }

  /** Request times for an email since `since`, newest first. */
  async emailRequestTimes(tx: Tx, emailHmac: Buffer, since: Date): Promise<Date[]> {
    const rows = await tx
      .selectFrom('otp_challenges')
      .select('created_at')
      .where('email_hmac', '=', emailHmac)
      .where('created_at', '>', since)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => row.created_at);
  }

  /**
   * One count at a time per IP, so parallel calls from one address cannot all
   * read the count before any of them has added to it. Held only for the
   * short transaction that records and counts.
   */
  async lockIp(tx: Tx, ip: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ip:${ip}`}, 0))`.execute(tx);
  }

  /** Notes a call to a public endpoint from this IP (API design 18.1). */
  async recordPublicCall(tx: Tx, ip: string, at: Date): Promise<void> {
    await tx
      .insertInto('public_call_hits')
      .values({ id: newId(), created_at: at, ip: sql<string>`${ip}::inet` })
      .execute();
  }

  /** Calls from this IP since `since`, oldest first. */
  async publicCallTimes(tx: Tx, ip: string, since: Date): Promise<Date[]> {
    const rows = await tx
      .selectFrom('public_call_hits')
      .select('created_at')
      .where('ip', '=', sql<string>`${ip}::inet`)
      .where('created_at', '>', since)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => row.created_at);
  }

  /** The latest end of a lock on this email: from a challenge (any email) or from the account. */
  async activeChallengeLock(tx: Tx, emailHmac: Buffer, now: Date): Promise<Date | null> {
    const row = await tx
      .selectFrom('otp_challenges')
      .select((eb) => eb.fn.max('locked_until').as('until'))
      .where('email_hmac', '=', emailHmac)
      .where('locked_until', '>', now)
      .executeTakeFirst();
    return row?.until ?? null;
  }

  /** A new code replaces the old one (API design 10.1). */
  async supersedeLive(tx: Tx, emailHmac: Buffer, now: Date): Promise<void> {
    await tx
      .updateTable('otp_challenges')
      .set({ superseded_at: now })
      .where('email_hmac', '=', emailHmac)
      .where('consumed_at', 'is', null)
      .where('superseded_at', 'is', null)
      .execute();
  }

  async insertChallenge(tx: Tx, challenge: NewChallenge): Promise<void> {
    await tx
      .insertInto('otp_challenges')
      .values({
        id: challenge.id,
        created_at: challenge.createdAt,
        email_hmac: challenge.emailHmac,
        user_id: challenge.userId,
        code_hmac: challenge.codeHmac,
        expires_at: challenge.expiresAt,
        request_ip: challenge.requestIp,
        consumed_at: null,
        superseded_at: null,
        locked_until: null,
      })
      .execute();
  }
}

/** A code is sent to these accounts; an Inactive or unknown email gets none. */
export function canReceiveCode(accountStatus: number): boolean {
  return (
    accountStatus === AccountStatus.Pending ||
    accountStatus === AccountStatus.Active ||
    accountStatus === AccountStatus.Blocked
  );
}
