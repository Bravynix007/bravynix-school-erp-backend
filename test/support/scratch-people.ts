import { sql, type Kysely } from 'kysely';
import { newId } from '../../src/common/ids/ids.js';

/** A new address for a person a test makes. */
export const scratchEmail = () => `${newId()}@accounts.test`;

/**
 * Removes people a test made, and what hangs off them: sessions, codes,
 * authenticators and grants. Children before parents; `db` connects as the
 * table owner. The audit log keeps its rows (it is append only).
 */
export async function removeScratchPeople(db: Kysely<unknown>, emails: readonly string[]) {
  if (emails.length === 0) return;
  const people = sql`(select id from users where email in (${sql.join(emails)}))`;
  await sql`delete from refresh_tokens where session_id in (select id from auth_sessions where user_id in ${people})`.execute(
    db,
  );
  await sql`delete from auth_sessions where user_id in ${people}`.execute(db);
  await sql`delete from mfa_challenges where user_id in ${people}`.execute(db);
  await sql`delete from user_totp_factors where user_id in ${people}`.execute(db);
  await sql`delete from otp_challenges where user_id in ${people}`.execute(db);
  await sql`delete from role_assignments where user_id in ${people}`.execute(db);
  await sql`delete from users where email in (${sql.join(emails)})`.execute(db);
}
