import { sql, type Kysely } from 'kysely';

/**
 * Foundation: extensions, the shared `set_updated_at()` trigger function and
 * the tenant helper functions row-level security policies use (DDD 5, 15.3).
 * No tables yet; each module adds its own.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists pgcrypto`.execute(db);
  await sql`create extension if not exists citext`.execute(db);
  await sql`create extension if not exists pg_trgm`.execute(db);
  await sql`create extension if not exists btree_gist`.execute(db);

  // Standard column rule (DDD 5.2): updated_at moves on every update; versioned
  // tables also raise `version`, which the app checks for 409 VERSION_CONFLICT.
  await sql`
    create or replace function set_updated_at() returns trigger
    language plpgsql as $$
    begin
      new.updated_at := now();
      return new;
    end;
    $$
  `.execute(db);

  await sql`
    create or replace function bump_version() returns trigger
    language plpgsql as $$
    begin
      new.version := old.version + 1;
      return new;
    end;
    $$
  `.execute(db);

  // Tenant settings written by applyTenant() at the start of every transaction.
  // An empty or missing setting reads as NULL, so policies fail closed.
  await sql`
    create or replace function app_current_person_id() returns uuid
    language sql stable as $$
      select nullif(current_setting('app.person_id', true), '')::uuid
    $$
  `.execute(db);
  await sql`
    create or replace function app_current_society_id() returns uuid
    language sql stable as $$
      select nullif(current_setting('app.society_id', true), '')::uuid
    $$
  `.execute(db);
  await sql`
    create or replace function app_current_institution_ids() returns uuid[]
    language sql stable as $$
      select coalesce(
        string_to_array(nullif(current_setting('app.institution_ids', true), ''), ',')::uuid[],
        '{}'::uuid[]
      )
    $$
  `.execute(db);
  await sql`
    create or replace function app_current_role_code() returns smallint
    language sql stable as $$
      select nullif(current_setting('app.role_code', true), '')::smallint
    $$
  `.execute(db);
  await sql`
    create or replace function app_is_super_admin() returns boolean
    language sql stable as $$
      select coalesce(app_current_role_code() = 1, false)
    $$
  `.execute(db);

  // The app's own database user gets data access only, never schema changes
  // (SDD 16.6). The role is created by infrastructure; skip quietly if absent.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant usage on schema public to erp_app;
        alter default privileges in schema public
          grant select, insert, update, delete on tables to erp_app;
        alter default privileges in schema public
          grant usage, select on sequences to erp_app;
        alter default privileges in schema public
          grant execute on functions to erp_app;
        grant execute on all functions in schema public to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists app_is_super_admin()`.execute(db);
  await sql`drop function if exists app_current_role_code()`.execute(db);
  await sql`drop function if exists app_current_institution_ids()`.execute(db);
  await sql`drop function if exists app_current_society_id()`.execute(db);
  await sql`drop function if exists app_current_person_id()`.execute(db);
  await sql`drop function if exists bump_version()`.execute(db);
  await sql`drop function if exists set_updated_at()`.execute(db);
}
