import { sql, type Kysely } from 'kysely';

/**
 * Notifications, part 1 (DDD 9.1 `push_devices`, 9.8 `inbox_items`; API design 9.1).
 *
 * - `push_devices`: the push token of one phone, tied to the session that registered it. Like the other identity
 *   tables it carries no tenant and is touched only by the Notifications module. The token is unique, so a
 *   reinstall moves it to the new session; a trigger removes it
 *   when the session ends (`ended_at` set), because the session row itself stays for 30 days; deleting the session
 *   or the person removes it by cascade as well.
 * - `inbox_items`: one row per receiver (fan-out on write), partitioned by month on `created_at`, so old months are
 *   dropped whole. A person reads, marks read and clears only their own rows (row-level security on `user_id`); the
 *   worker writes them for a Society's job. `uq_inbox_items_source` makes a rerun of a fan-out add nothing twice,
 *   because the rows take the source event's time as `created_at`.
 * - `maintenance.ensure_inbox_partitions(first_month, months_ahead)`: makes the monthly partitions, as the audit log
 *   does, and takes every right on each from the app role, because the policies of the parent do not reach a
 *   partition that is named. There is no default partition: a row of a month with no partition is refused, so the
 *   worker's sweep keeps three months ahead (B2b). It runs as its owner with a fixed search_path and holds no
 *   business rule.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table push_devices (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      user_id uuid not null references users (id) on delete cascade,
      session_id uuid not null references auth_sessions (id) on delete cascade,
      fcm_token varchar(512) not null,
      platform smallint not null,
      app_version varchar(20),
      app_language varchar(5) not null default 'en',
      last_seen_at timestamptz not null default now(),
      constraint ck_push_devices_platform check (platform in (1, 2)),
      constraint ck_push_devices_token check (btrim(fcm_token) <> '')
    )
  `.execute(db);
  await sql`create unique index uq_push_devices_fcm_token on push_devices (fcm_token)`.execute(db);
  await sql`create index ix_push_devices_user on push_devices (user_id)`.execute(db);
  await sql`create index ix_push_devices_session on push_devices (session_id)`.execute(db);
  // A session that ends (logout, logout of all, a block, a revoked grant, a changed email, a reused refresh token)
  // stops its phone getting pushes at once (API design 6.3): its rows are deleted here, whatever ended it. The session
  // row itself stays for 30 days (DDD 15), so the foreign key's cascade alone would leave the phone registered.
  await sql`
    create function push_devices_end_with_session() returns trigger
    language plpgsql as $$
    begin
      delete from push_devices where session_id = new.id;
      return null;
    end;
    $$
  `.execute(db);
  await sql`
    create trigger trg_auth_sessions_end_push_devices
      after update of ended_at on auth_sessions
      for each row when (old.ended_at is null and new.ended_at is not null)
      execute function push_devices_end_with_session()
  `.execute(db);

  await sql`
    create table inbox_items (
      id uuid not null default gen_random_uuid(),
      created_at timestamptz not null default now(),
      user_id uuid not null references users (id) on delete cascade,
      society_id uuid references societies (id),
      institution_id uuid,
      student_id uuid,
      category smallint not null,
      inbox_tab smallint not null default 1,
      title varchar(150) not null,
      body varchar(1000) not null,
      sender_display_name varchar(200),
      announcement_id uuid,
      source_key varchar(100) not null,
      target_type smallint,
      target_id uuid,
      read_at timestamptz,
      constraint pk_inbox_items primary key (id, created_at),
      constraint ck_inbox_items_category check (category between 0 and 10),
      constraint ck_inbox_items_tab check (inbox_tab between 1 and 4),
      constraint ck_inbox_items_title check (btrim(title) <> ''),
      constraint ck_inbox_items_target check ((target_type is null) = (target_id is null)),
      constraint ck_inbox_items_target_type check (target_type is null or target_type between 1 and 12),
      constraint ck_inbox_items_institution_needs_society
        check (institution_id is null or society_id is not null)
    ) partition by range (created_at)
  `.execute(db);
  await sql`
    create index ix_inbox_items_user_created on inbox_items (user_id, created_at desc, id desc)
  `.execute(db);
  await sql`
    create index ix_inbox_items_user_unread on inbox_items (user_id) where read_at is null
  `.execute(db);
  await sql`
    create unique index uq_inbox_items_source on inbox_items (user_id, source_key, created_at)
  `.execute(db);

  await sql`alter table inbox_items enable row level security`.execute(db);
  await sql`alter table inbox_items force row level security`.execute(db);
  await sql`
    create policy inbox_items_select on inbox_items for select using (user_id = app_current_person_id())
  `.execute(db);
  await sql`
    create policy inbox_items_update on inbox_items for update
      using (user_id = app_current_person_id()) with check (user_id = app_current_person_id())
  `.execute(db);
  await sql`
    create policy inbox_items_delete on inbox_items for delete using (user_id = app_current_person_id())
  `.execute(db);
  // The worker writes a Society's fan-out under that Society; it reads nothing of the receivers' items.
  await sql`
    create policy inbox_items_insert on inbox_items for insert
      with check (society_id = app_current_society_id())
  `.execute(db);

  await sql`create schema if not exists maintenance`.execute(db);
  await sql`
    create function maintenance.ensure_inbox_partitions(first_month date, months_ahead integer)
      returns integer
    language plpgsql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
    declare
      month_start date;
      part_name text;
      month_from timestamptz;
      month_to timestamptz;
      made integer := 0;
    begin
      if months_ahead < 0 or months_ahead > 24 then
        raise exception 'months_ahead must be between 0 and 24';
      end if;
      for i in 0..months_ahead loop
        month_start := (date_trunc('month', first_month) + make_interval(months => i))::date;
        part_name := format('inbox_items_%s', to_char(month_start, 'YYYY_MM'));
        if to_regclass(format('public.%I', part_name)) is null then
          month_from := (to_char(month_start, 'YYYY-MM-DD') || ' 00:00:00+00')::timestamptz;
          month_to := (to_char((month_start + interval '1 month')::date, 'YYYY-MM-DD')
            || ' 00:00:00+00')::timestamptz;
          execute format(
            'create table public.%I partition of public.inbox_items for values from (%L) to (%L)',
            part_name, month_from, month_to
          );
          -- A policy on the parent does not apply to a partition addressed by name, so the app role gets no rights
          -- on it at all (as for the audit log's partitions).
          if exists (select 1 from pg_roles where rolname = 'erp_app') then
            execute format('revoke all on table public.%I from erp_app', part_name);
          end if;
          made := made + 1;
        end if;
      end loop;
      return made;
    end;
    $$
  `.execute(db);
  await sql`revoke all on function maintenance.ensure_inbox_partitions(date, integer) from public`.execute(
    db,
  );
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant usage on schema maintenance to erp_app;
        grant execute on function maintenance.ensure_inbox_partitions(date, integer) to erp_app;
      end if;
    end;
    $$
  `.execute(db);

  // This month and the next three, as for the audit log (DDD 14.5).
  await sql`select maintenance.ensure_inbox_partitions(current_date, 3)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): people's inboxes live here.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop inbox_items in production: it holds the people’s inboxes');
  }
  await sql`drop function if exists maintenance.ensure_inbox_partitions(date, integer)`.execute(db);
  await sql`drop table if exists inbox_items`.execute(db);
  await sql`drop trigger if exists trg_auth_sessions_end_push_devices on auth_sessions`.execute(db);
  await sql`drop function if exists push_devices_end_with_session()`.execute(db);
  await sql`drop table if exists push_devices`.execute(db);
}
