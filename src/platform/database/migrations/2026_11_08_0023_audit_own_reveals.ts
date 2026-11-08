import { sql, type Kysely } from 'kysely';

/**
 * A person may read their own `identity.reveal` entries in every Society and Institution (DDD 15.6, API design
 * 10.9). The daily limit on reveals counts them, and a tenant session sees only its own Society's entries, and
 * only those of the Institutions it reaches: counted through the ordinary policy, the limit would restart for each
 * Institution and each Society, and would stop working for an Institution Admin once `audit_logs_select` is
 * narrowed to Owners (carried forward). The policy adds to `audit_logs_select`; it shows a person nothing but
 * their own reveals.
 *
 * Because that includes reveals made in other Societies, any list of audit entries must filter `society_id`
 * explicitly and not lean on row-level security alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create policy audit_logs_select_own_reveals on audit_logs for select
      using (action = 'identity.reveal' and actor_user_id = app_current_person_id())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop audit_logs_select_own_reveals in production: the reveal limit relies on it',
    );
  }
  await sql`drop policy if exists audit_logs_select_own_reveals on audit_logs`.execute(db);
}
