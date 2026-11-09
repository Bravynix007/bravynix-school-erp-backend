import { sql, type Kysely } from 'kysely';

/**
 * People, part 3 (API design 10.5): an Institution Admin grant is tied to the staff record of the person who holds
 * it (`role_assignments.staff_member_id`). INS-10, STF-05, STF-10 and STF-13 look the grants of a record up, which
 * the per-person and per-Institution indexes do not serve.
 *
 * DDD 9.1 also names keys from the grant to `staff_members`. They are not added here: the service keeps the rules
 * (INS-09 grants only to the person who holds an active record that reaches the Institution, and a deactivation or a
 * move of the record revokes its grants), but the test data of the earlier phases grants Admin access to people with
 * no staff record at all, and a key would need all of it rebuilt with real records (which also gives each of those
 * people a Teacher / Staff context). The keys wait for that rework; the key on the person also has to leave room for
 * STF-13, which moves a record to another person while the grants it held stay as history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create index ix_role_assignments_staff on role_assignments (staff_member_id)
      where staff_member_id is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the admin grant index in production');
  }
  await sql`drop index if exists ix_role_assignments_staff`.execute(db);
}
