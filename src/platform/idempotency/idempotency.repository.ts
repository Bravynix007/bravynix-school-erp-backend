import { Injectable } from '@nestjs/common';
import { sql, type Insertable, type Selectable } from 'kysely';
import type { Tx } from '../database/index.js';
import type { IdempotencyKeysTable } from './idempotency.tables.js';

export type StoredAnswer = Selectable<IdempotencyKeysTable>;
export type NewStoredAnswer = Insertable<IdempotencyKeysTable>;

/** Queries on `idempotency_keys`; every one runs in the caller's transaction. */
@Injectable()
export class IdempotencyRepository {
  /**
   * Takes the right to run this person's request with this key, held until the
   * transaction ends. `false` means another request holds it: the first one
   * is still running.
   */
  async claim(tx: Tx, person: string, key: string): Promise<boolean> {
    const { rows } = await sql<{ claimed: boolean }>`
      select pg_try_advisory_xact_lock(hashtextextended(${`idempotency:${person}:${key}`}, 0)) as claimed
    `.execute(tx);
    return rows[0]!.claimed;
  }

  find(tx: Tx, person: string, key: string): Promise<StoredAnswer | undefined> {
    return tx
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('user_id', '=', person)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  /** Writes the first answer; one that is already there stays, so a late refusal never overwrites a result. */
  async insert(tx: Tx, values: NewStoredAnswer): Promise<void> {
    await tx
      .insertInto('idempotency_keys')
      .values(values)
      .onConflict((conflict) => conflict.columns(['user_id', 'idempotency_key']).doNothing())
      .execute();
  }

  async remove(tx: Tx, person: string, key: string): Promise<void> {
    await tx
      .deleteFrom('idempotency_keys')
      .where('user_id', '=', person)
      .where('idempotency_key', '=', key)
      .execute();
  }

  /** The hourly sweep: deletes every answer past its 24 hours and says how many. */
  async removeExpired(tx: Tx, now: Date): Promise<number> {
    const result = await tx
      .deleteFrom('idempotency_keys')
      .where('expires_at', '<=', now)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
