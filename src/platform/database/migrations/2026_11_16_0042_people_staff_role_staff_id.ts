import { sql, type Kysely } from 'kysely';

/**
 * A teacher's role 4 context names their staff record (API design 10.2): `staffMemberId` and `homeInstitutionId`, so
 * the app can open "My details" and the Documents tab (STF-03, STF-14 for oneself) without searching a list a teacher
 * cannot read. `app_staff_roles` (migrations 0025 and 0027) returned the home Institution but not the record's ID, so
 * it is replaced with one more column at the end. A function's result columns cannot change in place, so it is
 * dropped and made again with the same body, owner, search_path and grant: only the app role may call it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop function app_staff_roles(uuid)`.execute(db);
  await sql`
    create function app_staff_roles(person uuid)
      returns table (
        society_id uuid, home_institution_id uuid, society_name text, staff_blocked boolean,
        staff_member_id uuid
      )
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
          not exists (
            select 1 from (
              select m.home_institution_id as institution_id
              union
              select x.id from app_staff_extra_institutions(m.society_id, person) as x(id)
                join institutions xi on xi.id = x.id and xi.status = 1
            ) reached
            where not exists (
              select 1 from access_blocks b
              where b.society_id = m.society_id and b.institution_id = reached.institution_id
                and b.section = 2 and b.lifted_at is null
            )
          ),
          m.id
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
  // Production migrations only add (SDD 16.6): sign-in relies on this function, so it is not taken back there.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop staff_member_id from app_staff_roles in production: sign-in relies on it',
    );
  }
  await sql`drop function app_staff_roles(uuid)`.execute(db);
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
          not exists (
            select 1 from (
              select m.home_institution_id as institution_id
              union
              select x.id from app_staff_extra_institutions(m.society_id, person) as x(id)
                join institutions xi on xi.id = x.id and xi.status = 1
            ) reached
            where not exists (
              select 1 from access_blocks b
              where b.society_id = m.society_id and b.institution_id = reached.institution_id
                and b.section = 2 and b.lifted_at is null
            )
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
