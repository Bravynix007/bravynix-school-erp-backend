import { sql, type Kysely } from 'kysely';

/**
 * `app_has_staff_elsewhere(person, society)`: does the person have an active staff record in a Society other than
 * `society`, whatever the status of that Society or its home Institution? The email change of a staff member (STF-13,
 * API design 6.6) may change the person's own email only when this record is all they hold, and a record in a
 * deactivated Society or Institution is access that returns with it. Row-level security shows a tenant no other
 * Society's rows, so the question is asked through a definer function that answers the one boolean: like the functions
 * of migrations 0011 and 0025 it acts as Super Admin for the read, puts the caller's settings back before it
 * returns, has a fixed search_path, and only the app role may call it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function app_has_staff_elsewhere(person uuid, home_society uuid)
      returns boolean
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_person text := current_setting('app.person_id', true);
      found boolean;
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.person_id', person::text, true);
      select exists (
        select 1 from staff_members m
        where m.user_id = person and m.society_id <> home_society and m.status = 1
      ) into found;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.person_id', coalesce(caller_person, ''), true);
      return found;
    end;
    $$
  `.execute(db);
  await sql`revoke all on function app_has_staff_elsewhere(uuid, uuid) from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function app_has_staff_elsewhere(uuid, uuid) to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the staff email change relies on it.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop app_has_staff_elsewhere in production: STF-13 relies on it');
  }
  await sql`drop function if exists app_has_staff_elsewhere(uuid, uuid)`.execute(db);
}
