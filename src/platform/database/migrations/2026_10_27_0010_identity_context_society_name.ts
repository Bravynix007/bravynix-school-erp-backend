import { sql, type Kysely } from 'kysely';

/**
 * Identity, part 5: the Society's name for the role chooser (API design 6.3).
 * Sign-in runs before any role is set, so row-level security hides every
 * Society from it (the table forces row-level security even on its owner).
 * This function hands back the name of one Society and nothing else; the
 * caller passes only the Societies the person holds a grant in. It acts as
 * Super Admin for the one read and puts the caller's role setting back before
 * it returns, with a fixed search_path, and only the app role may call it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function app_society_name(society uuid) returns text
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      found_name text;
    begin
      perform set_config('app.role_code', '1', true);
      select name into found_name from societies where id = society;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      return found_name;
    end;
    $$
  `.execute(db);
  await sql`revoke all on function app_society_name(uuid) from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function app_society_name(uuid) to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop the Society name function in production (production migrations only add)',
    );
  }
  await sql`drop function if exists app_society_name(uuid)`.execute(db);
}
