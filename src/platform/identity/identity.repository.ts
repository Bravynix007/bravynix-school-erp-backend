import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { Db, Tx } from '../database/index.js';
import { AccountStatus } from './auth-codes.js';
import { OTP_LIMITS } from './otp-limits.js';

const OTP_MAX_ATTEMPTS = OTP_LIMITS.attemptsPerCode;

export interface LoginUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  accountStatus: number;
  preferredLanguage: string;
  lockedUntil: Date | null;
}

/** A code that can still be tried: not used, replaced, expired or out of tries. */
export interface LiveChallenge {
  id: string;
  userId: string | null;
  codeHmac: Buffer | null;
  attemptCount: number;
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
      .select([
        'id',
        'email',
        'first_name',
        'last_name',
        'account_status',
        'preferred_language',
        'locked_until',
      ])
      .where('email', '=', email)
      .executeTakeFirst();
    return (
      row && {
        id: row.id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
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
   * window, keyed by the caller key. `scope` keeps the counters of different
   * endpoint groups apart (1 login codes, 2 refresh).
   */
  async countPublicCall(db: Db, scope: number, ip: string, windowStart: Date): Promise<number> {
    const { rows } = await sql<{ calls: number }>`
      insert into public_call_counters (scope, ip, window_start, calls)
      select ${scope}, ${callerKey(sql.ref('a'))}, ${windowStart}, 1
      from (select ${ip}::inet as a) as caller
      on conflict (scope, ip, window_start)
        do update set calls = public_call_counters.calls + 1
      returning calls`.execute(db);
    return rows[0]!.calls;
  }

  /** The latest end of a lock on this email, from its challenges or its lockout record (any email, registered or not). */
  async activeChallengeLock(tx: Tx, emailHmac: Buffer, now: Date): Promise<Date | null> {
    // The lockout record outlives the challenges, so a sweep of old codes never lifts a lock.
    const { rows } = await sql<{ until: Date | null }>`
      select greatest(
        (select max(locked_until) from otp_challenges
          where email_hmac = ${emailHmac} and locked_until > ${now}),
        (select max(locked_until) from login_lockouts
          where email_hmac = ${emailHmac} and locked_until > ${now})
      ) as until`.execute(tx);
    return rows[0]?.until ?? null;
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

  /**
   * A new code starts with the wrong tries already counted against the email
   * (the newest challenge's count while it is below the limit and the email
   * has not signed in since), so asking for a new code never gives fresh
   * tries. The same for a registered and an unknown email.
   */
  async insertChallenge(tx: Tx, challenge: NewChallenge): Promise<void> {
    await sql`
      insert into otp_challenges
        (id, created_at, email_hmac, user_id, code_hmac, expires_at, request_ip, attempt_count)
      values (
        ${challenge.id}, ${challenge.createdAt}, ${challenge.emailHmac}, ${challenge.userId},
        ${challenge.codeHmac}, ${challenge.expiresAt}, ${challenge.requestIp}::inet,
        coalesce((
          select case when consumed_at is null and attempt_count < ${OTP_MAX_ATTEMPTS}
                      then attempt_count else 0 end
          from otp_challenges
          where email_hmac = ${challenge.emailHmac}
          order by created_at desc, id desc
          limit 1
        ), 0)
      )`.execute(tx);
  }

  // Verifying a code (API design 10.2) ---------------------------------------

  /** Codes that can still be tried for this email, locked for the rest of the transaction. */
  async liveChallenges(tx: Tx, emailHmac: Buffer, now: Date): Promise<LiveChallenge[]> {
    const rows = await tx
      .selectFrom('otp_challenges')
      .select(['id', 'user_id', 'code_hmac', 'attempt_count'])
      .where('email_hmac', '=', emailHmac)
      .where('consumed_at', 'is', null)
      .where('superseded_at', 'is', null)
      .where('expires_at', '>', now)
      .where('attempt_count', '<', OTP_MAX_ATTEMPTS)
      .orderBy('created_at', 'desc')
      .forUpdate()
      .execute();
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      codeHmac: row.code_hmac,
      attemptCount: row.attempt_count,
    }));
  }

  /** A wrong code: every live code for the email now shows the same number of wrong tries. */
  async setAttemptCount(tx: Tx, ids: readonly string[], count: number): Promise<void> {
    await tx
      .updateTable('otp_challenges')
      .set({ attempt_count: count })
      .where('id', 'in', ids)
      .execute();
  }

  /** Lockouts of this email since `since`, so the next one knows how long to lock. */
  async lockoutsSince(tx: Tx, emailHmac: Buffer, since: Date): Promise<number> {
    const row = await tx
      .selectFrom('login_lockouts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('email_hmac', '=', emailHmac)
      .where('created_at', '>', since)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async recordLockout(tx: Tx, emailHmac: Buffer, until: Date, now: Date): Promise<void> {
    await tx
      .insertInto('login_lockouts')
      .values({ email_hmac: emailHmac, locked_until: until, created_at: now })
      .execute();
  }

  /** Locks the email: every recent challenge for it shows the lock, so a new request meets it too. */
  async lockChallenges(tx: Tx, emailHmac: Buffer, until: Date, since: Date): Promise<void> {
    await tx
      .updateTable('otp_challenges')
      .set({ locked_until: until })
      .where('email_hmac', '=', emailHmac)
      .where('created_at', '>', since)
      .execute();
  }

  /** A correct code: it is used up and any other live code for the email is replaced. */
  async consumeChallenge(tx: Tx, emailHmac: Buffer, usedId: string, now: Date): Promise<void> {
    await tx
      .updateTable('otp_challenges')
      .set({ consumed_at: now })
      .where('id', '=', usedId)
      .execute();
    await tx
      .updateTable('otp_challenges')
      .set({ superseded_at: now })
      .where('email_hmac', '=', emailHmac)
      .where('id', '<>', usedId)
      .where('consumed_at', 'is', null)
      .where('superseded_at', 'is', null)
      .execute();
  }

  /** The count shown to admins; the rule itself runs on the challenges. */
  async setUserFailures(
    tx: Tx,
    userId: string,
    count: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    await tx
      .updateTable('users')
      .set({ failed_login_count: count, ...(lockedUntil ? { locked_until: lockedUntil } : {}) })
      .where('id', '=', userId)
      .execute();
  }

  /** A sign-in: counters cleared, times noted, a Pending account becomes Active. */
  async recordLogin(tx: Tx, userId: string, now: Date): Promise<void> {
    await sql`
      update users set
        failed_login_count = 0,
        locked_until = null,
        last_login_at = ${now},
        first_login_at = coalesce(first_login_at, ${now}),
        account_status = case when account_status = ${AccountStatus.Pending} then ${AccountStatus.Active} else account_status end
      where id = ${userId}`.execute(tx);
  }

  /** A blocked person's correct code still clears the wrong-try counters. */
  async clearFailures(tx: Tx, userId: string): Promise<void> {
    await tx
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null })
      .where('id', '=', userId)
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
