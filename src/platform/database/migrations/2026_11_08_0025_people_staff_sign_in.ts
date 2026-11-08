import { sql, type Kysely } from 'kysely';

/**
 * People, part 2 (DDD 7.2 decision M1, DDD 15.3 "own records"): a person with an active staff record signs in as a
 * Teacher / Staff, the role the record gives them.
 *
 * - `staff_members` shows a person their own records in every Society, besides the Society's rows to its tenant. The
 *   scope resolver has to read them before it knows an Institution.
 * - `app_staff_roles(person)` hands sign-in, the role chooser and the per-request check what they need of those
 *   records and nothing else: the Society, its name, the home Institution and whether that Institution has its
 *   staff blocked. Sign-in runs before any role is set, so row-level security would hide every record from it. Like
 *   the two functions of migration 0011, it acts as Super Admin for the one read, as the person it is asked about,
 *   puts the caller's settings back before it returns, has a fixed search_path, and only the app role may call it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy staff_members_select on staff_members`.execute(db);
  await sql`
    create policy staff_members_select on staff_members for select
      using (society_id = app_current_society_id() or user_id = app_current_person_id())
  `.execute(db);
  await sql`
    create function app_staff_roles(person uuid)
      returns table (society_id uuid, home_institution_id uuid, society_name text, staff_blocked boolean)
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_person text := current_setting('app.person_id', true);
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.person_id', person::text, true);
      return query
        select m.society_id, m.home_institution_id, s.name::text,
          exists (
            select 1 from access_blocks b
            where b.society_id = m.society_id and b.institution_id = m.home_institution_id
              and b.section = 2 and b.lifted_at is null
          )
        from staff_members m
        join societies s on s.id = m.society_id and s.status = 1
        join institutions i on i.id = m.home_institution_id and i.status = 1
        where m.user_id = person and m.status = 1
        order by m.created_at, m.id;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.person_id', coalesce(caller_person, ''), true);
    end;
    $$
  `.execute(db);
  await sql`revoke all on function app_staff_roles(uuid) from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function app_staff_roles(uuid) to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): sign-in relies on this function.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop app_staff_roles in production: sign-in relies on it');
  }
  await sql`drop function if exists app_staff_roles(uuid)`.execute(db);
  await sql`drop policy staff_members_select on staff_members`.execute(db);
  await sql`
    create policy staff_members_select on staff_members for select
      using (society_id = app_current_society_id())
  `.execute(db);
}
