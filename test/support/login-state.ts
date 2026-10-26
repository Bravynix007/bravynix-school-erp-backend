import { sql, type Kysely } from 'kysely';

/**
 * Empties everything a sign-in leaves behind: sessions, refresh tokens, login
 * codes, the per-address call counters and lockouts. Lockouts and counters
 * outlive a spec file, and a stale one makes a later spec fail with 423 or 429
 * depending on the order the files run in, so every spec that signs in or asks
 * for a code clears them first. Children before parents.
 */
export async function clearLoginState(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'refresh_tokens',
    'auth_sessions',
    'otp_challenges',
    'public_call_counters',
    'login_lockouts',
  ]) {
    await sql`delete from ${sql.table(table)}`.execute(db);
  }
}
