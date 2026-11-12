import { sql, type Kysely } from 'kysely';

/**
 * People, part 8 (API design 6.6, GDN-03): how many active guardian links a person holds, in any Society.
 *
 * A guardian's login email changes by the three outcomes of STF-13: the person's own email changes only when this
 * guardian link is all they hold, otherwise the link moves to another person. Whether they hold other links, at other
 * children or in other Societies, is not visible to the admin who asks: row-level security shows a tenant only its own
 * Institutions' rows. `app_guardian_link_count(person)` answers the one number, as `app_is_guardian` (migration 0031)
 * answers the one boolean: it acts as Super Admin for the read, puts the caller's settings back before it returns, has
 * a fixed search_path, and only the app role may call it. A link counts while its guardian is active, whatever the
 * status of the student, the Institution or the Society: dormant access returns with them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function app_guardian_link_count(person uuid) returns integer
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_person text := current_setting('app.person_id', true);
      found integer;
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.person_id', person::text, true);
      select count(*)::integer from student_guardians g
        where g.user_id = person and g.status = 1
        into found;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.person_id', coalesce(caller_person, ''), true);
      return found;
    end;
    $$
  `.execute(db);
  await sql`revoke all on function app_guardian_link_count(uuid) from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function app_guardian_link_count(uuid) to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the guardian email change relies on it.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop app_guardian_link_count in production: GDN-03 relies on it');
  }
  await sql`drop function if exists app_guardian_link_count(uuid)`.execute(db);
}
