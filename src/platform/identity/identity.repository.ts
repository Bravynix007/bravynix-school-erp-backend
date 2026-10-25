import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { Db, Tx } from '../database/index.js';
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
 * The caller key: the address a limit counts. An IPv6 caller is its /64
 * network, because one device may use any address in it; an IPv4 caller is
 * itself. The per-IP limit, the per-address request limit and the code
 * replacement all use this one definition. `request_ip` keeps the full address.
 */
function callerKey(address: RawBuilder<unknown>): RawBuilder<string> {
  return sql<string>`(case when family(${address}) = 6 then network(set_masklen(${address}, 64))::inet else ${address} end)`;
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

  /**
   * Request times for an email since `since`, newest first, each marked with
   * whether it came from the same address as this request.
   */
  async emailRequestTimes(
    tx: Tx,
    emailHmac: Buffer,
    ip: string | null,
    since: Date,
  ): Promise<{ at: Date; sameAddress: boolean }[]> {
    const { rows } = await sql<{ created_at: Date; same: boolean }>`
      select created_at, (${callerKey(sql.ref('request_ip'))} is not distinct from ${callerKey(sql`${ip}::inet`)}) as same
      from otp_challenges
      where email_hmac = ${emailHmac} and created_at > ${since}
      order by created_at desc`.execute(tx);
    return rows.map((row) => ({ at: row.created_at, sameAddress: row.same }));
  }

  /**
   * Counts a call to a public endpoint from this IP in the window and returns
   * the count so far. One autocommitted statement, so a flood neither holds a
   * transaction nor waits on a lock, and the row count stays at one per IP per
   * window, keyed by the caller key.
   */
  async countPublicCall(db: Db, ip: string, windowStart: Date): Promise<number> {
    const { rows } = await sql<{ calls: number }>`
      insert into public_call_counters (ip, window_start, calls)
      select ${callerKey(sql.ref('a'))}, ${windowStart}, 1
      from (select ${ip}::inet as a) as caller
      on conflict (ip, window_start)
        do update set calls = public_call_counters.calls + 1
      returning calls`.execute(db);
    return rows[0]!.calls;
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

  /**
   * A new code replaces the old one from the same address (API design 10.1).
   * A request from another address leaves it alone, so a stranger cannot
   * cancel the person's code.
   */
  async supersedeLive(tx: Tx, emailHmac: Buffer, ip: string | null, now: Date): Promise<void> {
    await sql`
      update otp_challenges set superseded_at = ${now}
      where email_hmac = ${emailHmac}
        and consumed_at is null and superseded_at is null
        and ${callerKey(sql.ref('request_ip'))} is not distinct from ${callerKey(sql`${ip}::inet`)}`.execute(
      tx,
    );
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
