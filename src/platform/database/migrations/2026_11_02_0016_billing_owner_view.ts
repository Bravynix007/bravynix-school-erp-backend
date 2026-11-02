import { sql, type Kysely } from 'kysely';

/**
 * Platform billing, part 4: a Society Owner reads the dues raised against their
 * own Society (BIL-01, BIL-02; PRD 9.3). The select policy of `platform_dues`
 * gains the Society rule for the Owner role only. An Institution Admin shares
 * the Owner's Society setting, so the policy names role 2: Admins never see
 * pricing or dues (PRD 3.2). Writes stay Super Admin's alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists platform_dues_select on platform_dues`.execute(db);
  await sql`
    create policy platform_dues_select on platform_dues for select
      using (
        app_is_super_admin()
        or (app_current_role_code() = 2 and society_id = app_current_society_id())
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the platform_dues owner read policy in production');
  }
  await sql`drop policy if exists platform_dues_select on platform_dues`.execute(db);
  await sql`
    create policy platform_dues_select on platform_dues for select
      using (app_is_super_admin())
  `.execute(db);
}
