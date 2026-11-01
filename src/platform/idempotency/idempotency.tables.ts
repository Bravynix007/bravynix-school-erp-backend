import type { ColumnType } from 'kysely';

/**
 * Kysely type of `idempotency_keys` (DDD 9.1): the first answer to each of the
 * operations that need an `Idempotency-Key`, kept for 24 hours. A stored answer
 * is never edited.
 */
export interface IdempotencyKeysTable {
  user_id: string;
  idempotency_key: string;
  /** For example `billing.raise_due`. */
  operation: string;
  /** SHA-256 of the normalised request. */
  request_fingerprint: Buffer;
  /** HTTP status of the first result: 2xx, or a 409 or 422 refusal. */
  response_status: number;
  /** The first answer as JSON text; never holds masked or sensitive fields. */
  response_body: ColumnType<unknown, string, never>;
  resource_id: string | null;
  created_at: ColumnType<Date, Date, never>;
  expires_at: ColumnType<Date, Date, never>;
}
