import { sql, type Kysely } from 'kysely';

/**
 * Tenancy, part 2: section blocks replace the whole Society and Institution
 * pause (owner decision, 26 Oct 2026; DDD 9.3). Super Admin blocks one section
 * of people, and everyone else keeps working:
 *
 * - `owners` (1): a Society's Owners, no Institution;
 * - `staff` (2): one Institution's Institution Admins and Teachers and Staff;
 * - `students` (3): parents' access to one Institution's students.
 *
 * A block is a row that has to exist to stop someone, so the request gate does
 * not read the table through row-level security, which can hide the row from
 * the very person it should stop. It asks `app_active_blocks`, a definer
 * function the caller's tenant cannot narrow. Lifting sets `lifted_at` and
 * keeps the row.
 *
 * Both definer functions answer only for a Society where the named person holds
 * an active grant, so a caller cannot read the blocks or the name of any other
 * Society through them. `app_society_name` (0010) gets the same rule here.
 * Teachers and parents hold no grant until the People module; it widens the
 * rule then.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // The guard function reads the pause columns, so it goes first or every
  // insert and update of a Society or Institution would fail once they are gone.
  await sql`
    create or replace function tenancy_guard_platform_columns() returns trigger
    language plpgsql as $$
    begin
      if not app_is_super_admin() and (
        tg_op = 'UPDATE' and tg_table_name = 'societies'
        and (new.code is distinct from old.code or new.status is distinct from old.status)
      ) then
        raise exception 'Only Super Admin may change % status or code', tg_table_name
          using errcode = '42501';
      end if;
      return new;
    end;
    $$
  `.execute(db);
  for (const table of ['societies', 'institutions']) {
    await sql`alter table ${sql.table(table)} drop constraint ${sql.id(`ck_${table}_pause`)}`.execute(
      db,
    );
    await sql`
      alter table ${sql.table(table)}
        drop column access_paused_at, drop column access_paused_by, drop column access_pause_reason
    `.execute(db);
  }

  await sql`
    create table access_blocks (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid not null references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid,
      section smallint not null,
      reason varchar(500) not null,
      lifted_at timestamptz,
      lifted_by uuid references users (id),
      constraint fk_access_blocks_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint ck_access_blocks_section check (section in (1, 2, 3)),
      constraint ck_access_blocks_scope check ((section = 1) = (institution_id is null)),
      constraint ck_access_blocks_reason check (btrim(reason) <> ''),
      constraint ck_access_blocks_lift check ((lifted_at is null) = (lifted_by is null))
    )
  `.execute(db);
  // One active block per section, owners included (their Institution is null).
  await sql`
    create unique index uq_access_blocks_active
      on access_blocks (society_id, institution_id, section) nulls not distinct
      where lifted_at is null
  `.execute(db);
  await sql`
    create trigger trg_access_blocks_updated before update on access_blocks
      for each row execute function set_updated_at()
  `.execute(db);

  // Super Admin writes; an Owner reads their own Society's blocks to see why a
  // section is stopped (SOC-02). An Institution Admin shares the Owner's
  // Society setting, so the policy names role 2.
  await sql`alter table access_blocks enable row level security`.execute(db);
  await sql`alter table access_blocks force row level security`.execute(db);
  await sql`
    create policy access_blocks_select on access_blocks for select
      using (
        app_is_super_admin()
        or (app_current_role_code() = 2 and society_id = app_current_society_id())
      )
  `.execute(db);
  await sql`
    create policy access_blocks_insert on access_blocks for insert
      with check (app_is_super_admin())
  `.execute(db);
  await sql`
    create policy access_blocks_update on access_blocks for update
      using (app_is_super_admin())
      with check (app_is_super_admin())
  `.execute(db);
  // History stays: the foundation's default privileges grant DELETE, take it
  // back. Only the lift columns can change, so a block's section and reason are
  // never rewritten.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate, update on table access_blocks from erp_app;
        grant update (lifted_at, lifted_by, updated_at, updated_by) on table access_blocks to erp_app;
      end if;
    end;
    $$
  `.execute(db);

  await sql`
    create function app_active_blocks(society uuid, person uuid)
      returns table (section smallint, institution_id uuid)
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
    begin
      perform set_config('app.role_code', '1', true);
      return query
        select b.section, b.institution_id from access_blocks b
        where b.society_id = society and b.lifted_at is null
          and exists (
            select 1 from role_assignments g
            where g.user_id = person and g.society_id = society and g.revoked_at is null
          );
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
    end;
    $$
  `.execute(db);
  await sql`drop function app_society_name(uuid)`.execute(db);
  await sql`
    create function app_society_name(society uuid, person uuid) returns text
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      found_name text;
    begin
      perform set_config('app.role_code', '1', true);
      select s.name into found_name from societies s
      where s.id = society
        and exists (
          select 1 from role_assignments g
          where g.user_id = person and g.society_id = society and g.revoked_at is null
        );
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      return found_name;
    end;
    $$
  `.execute(db);
  for (const fn of ['app_active_blocks(uuid, uuid)', 'app_society_name(uuid, uuid)']) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
    await sql`
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'erp_app') then
          grant execute on function ${sql.raw(fn)} to erp_app;
        end if;
      end;
      $$
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop access_blocks in production: it holds the block history');
  }
  await sql`drop function if exists app_active_blocks(uuid, uuid)`.execute(db);
  await sql`drop function if exists app_society_name(uuid, uuid)`.execute(db);
  await sql`drop table if exists access_blocks`.execute(db);
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
  for (const table of ['societies', 'institutions']) {
    await sql`
      alter table ${sql.table(table)}
        add column access_paused_at timestamptz,
        add column access_paused_by uuid references users (id),
        add column access_pause_reason varchar(500)
    `.execute(db);
    await sql`
      alter table ${sql.table(table)} add constraint ${sql.id(`ck_${table}_pause`)} check (
        (access_paused_at is null) = (access_paused_by is null)
        and (access_paused_at is null) = (access_pause_reason is null)
      )
    `.execute(db);
  }
  await sql`
    create or replace function tenancy_guard_platform_columns() returns trigger
    language plpgsql as $$
    begin
      if not app_is_super_admin() and (
        new.access_paused_at is distinct from old.access_paused_at
        or new.access_paused_by is distinct from old.access_paused_by
        or new.access_pause_reason is distinct from old.access_pause_reason
        or (
          tg_op = 'UPDATE' and tg_table_name = 'societies'
          and (new.code is distinct from old.code or new.status is distinct from old.status)
        )
      ) then
        raise exception 'Only Super Admin may change % pause, status or code', tg_table_name
          using errcode = '42501';
      end if;
      return new;
    end;
    $$
  `.execute(db);
}
