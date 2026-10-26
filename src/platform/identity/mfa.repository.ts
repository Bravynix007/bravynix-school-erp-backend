import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Db, Tx } from '../database/index.js';

/** The authenticator of one Super Admin; it counts once `confirmedAt` is set. */
export interface TotpFactor {
  secretCiphertext: Buffer;
  confirmedAt: Date | null;
  lastUsedStep: number | null;
  /** The console is closed to this person until then, after too many wrong codes. */
  lockedUntil: Date | null;
}

/** A sign-in token read with its row locked. */
export interface LockedMfaChallenge {
  id: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
  failedTries: number;
}

/** Authenticator factors and the step-two tokens (DDD 9.1). Only the Identity module touches these tables. */
@Injectable()
export class MfaRepository {
  async findFactor(db: Db, userId: string): Promise<TotpFactor | undefined> {
    const row = await db
      .selectFrom('user_totp_factors')
      .select(['secret_ciphertext', 'confirmed_at', 'last_used_step', 'locked_until'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return (
      row && {
        secretCiphertext: row.secret_ciphertext,
        confirmedAt: row.confirmed_at,
        lastUsedStep: row.last_used_step,
        lockedUntil: row.locked_until,
      }
    );
  }

  /** Stores a new secret, replacing one that was never confirmed. A confirmed factor is left alone and false is returned. */
  async savePendingFactor(
    tx: Tx,
    userId: string,
    sealed: Buffer,
    keyVersion: number,
  ): Promise<boolean> {
    const result = await tx
      .insertInto('user_totp_factors')
      .values({
        user_id: userId,
        secret_ciphertext: sealed,
        secret_key_version: keyVersion,
        confirmed_at: null,
        last_used_step: null,
      })
      .onConflict((conflict) =>
        conflict
          .column('user_id')
          .doUpdateSet({ secret_ciphertext: sealed, secret_key_version: keyVersion })
          .where('user_totp_factors.confirmed_at', 'is', null),
      )
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows) > 0;
  }

  /**
   * Records the step a code was accepted at and confirms the factor, in one
   * statement that refuses a step at or before the last one used. So two
   * sign-ins racing with one code cannot both pass: the second gets false.
   */
  async useStep(tx: Tx, userId: string, step: number, now: Date): Promise<boolean> {
    const result = await sql`
      update user_totp_factors set
        last_used_step = ${step},
        confirmed_at = coalesce(confirmed_at, ${now}),
        wrong_codes = 0,
        wrong_since = null
      where user_id = ${userId} and (last_used_step is null or last_used_step < ${step})`.execute(
      tx,
    );
    return Number(result.numAffectedRows) > 0;
  }

  /**
   * Counts a wrong code against the person, over all their tokens: the count
   * starts again when the first of them is more than `windowStart` old. At
   * `cap` the console is locked until `lockedUntil` and the count is cleared.
   * Returns the lock when one was set. Both statements hold the factor's row,
   * so wrong codes arriving together are counted one after the other.
   */
  async countWrongCode(
    tx: Tx,
    userId: string,
    now: Date,
    window: { start: Date; cap: number; lockedUntil: Date },
  ): Promise<Date | null> {
    const { rows } = await sql<{ wrong_codes: number }>`
      update user_totp_factors set
        wrong_codes = case when wrong_since is null or wrong_since <= ${window.start} then 1 else wrong_codes + 1 end,
        wrong_since = case when wrong_since is null or wrong_since <= ${window.start} then ${now} else wrong_since end
      where user_id = ${userId}
      returning wrong_codes`.execute(tx);
    if ((rows[0]?.wrong_codes ?? 0) < window.cap) return null;
    await sql`
      update user_totp_factors set locked_until = ${window.lockedUntil}, wrong_codes = 0, wrong_since = null
      where user_id = ${userId}`.execute(tx);
    return window.lockedUntil;
  }

  async insertChallenge(
    tx: Tx,
    challenge: { id: string; userId: string; hmac: Buffer; expiresAt: Date; now: Date },
  ): Promise<void> {
    await tx
      .insertInto('mfa_challenges')
      .values({
        id: challenge.id,
        created_at: challenge.now,
        user_id: challenge.userId,
        token_hmac: challenge.hmac,
        expires_at: challenge.expiresAt,
        used_at: null,
      })
      .execute();
  }

  /** A new sign-in replaces the person's earlier tokens that are still open. */
  async spendOpenChallenges(tx: Tx, userId: string, now: Date): Promise<void> {
    await tx
      .updateTable('mfa_challenges')
      .set({ used_at: now })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .execute();
  }

  /** Finds the token by its hash and holds its row until the transaction ends, so two tries with it run one after the other. */
  async lockChallenge(tx: Tx, hmac: Buffer): Promise<LockedMfaChallenge | undefined> {
    const row = await tx
      .selectFrom('mfa_challenges')
      .select(['id', 'user_id', 'expires_at', 'used_at', 'failed_tries'])
      .where('token_hmac', '=', hmac)
      .forUpdate()
      .executeTakeFirst();
    return (
      row && {
        id: row.id,
        userId: row.user_id,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        failedTries: row.failed_tries,
      }
    );
  }

  /** Counts a wrong code and returns the new count. */
  async addFailedTry(tx: Tx, id: string): Promise<number> {
    const row = await tx
      .updateTable('mfa_challenges')
      .set({ failed_tries: sql<number>`failed_tries + 1` })
      .where('id', '=', id)
      .returning('failed_tries')
      .executeTakeFirstOrThrow();
    return row.failed_tries;
  }

  async spendChallenge(tx: Tx, id: string, now: Date): Promise<void> {
    await tx.updateTable('mfa_challenges').set({ used_at: now }).where('id', '=', id).execute();
  }
}
