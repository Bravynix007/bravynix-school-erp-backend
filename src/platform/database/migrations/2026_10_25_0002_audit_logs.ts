import { sql, type Kysely } from 'kysely';

/**
 * Audit log (DDD 9.12, 15.8): who did what, when, with before and after
 * values. Append-only, partitioned by month, tenant-tagged, and written in the
 * caller's transaction.
 *
 * Three locks keep it unchangeable by the application: the app role has only
 * SELECT and INSERT, a trigger rejects UPDATE and DELETE even for the owner,
 * and the monthly partitions are not reachable by name from the app role.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create schema if not exists maintenance`.execute(db);

  await sql`
    create table audit_logs (
      id uuid not null default gen_random_uuid(),
      created_at timestamptz not null default now(),
      society_id uuid,
      institution_id uuid,
      actor_user_id uuid,
      actor_role_code smallint,
      actor_display_name varchar(200),
      via_support_access boolean not null default false,
      action varchar(60) not null,
      entity_type varchar(60),
      entity_id uuid,
      outcome smallint not null default 1,
      reason varchar(500),
      request_id uuid,
      ip_address inet,
      user_agent varchar(300),
      old_values jsonb,
      new_values jsonb,
      constraint pk_audit_logs primary key (id, created_at),
      constraint ck_audit_logs_role_code check (actor_role_code between 1 and 5),
      constraint ck_audit_logs_outcome check (outcome in (1, 2, 3)),
      constraint ck_audit_logs_action check (action ~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)+$'),
      constraint ck_audit_logs_institution_needs_society
        check (institution_id is null or society_id is not null)
    ) partition by range (created_at)
  `.execute(db);

  // The four filters of PRD 9.6 and a record's history (DDD 9.12). The action
  // filter runs inside these, so it has no index of its own.
  await sql`create index ix_audit_logs_society_created on audit_logs (society_id, created_at desc)`.execute(
    db,
  );
  await sql`create index ix_audit_logs_institution_created on audit_logs (institution_id, created_at desc)`.execute(
    db,
  );
  await sql`create index ix_audit_logs_actor_created on audit_logs (actor_user_id, created_at desc)`.execute(
    db,
  );
  await sql`create index ix_audit_logs_entity on audit_logs (entity_type, entity_id)`.execute(db);

  // Second guard (DDD 15.8). Row triggers on a partitioned table are copied to
  // every partition, including ones made later.
  await sql`
    create function audit_logs_reject_change() returns trigger
    language plpgsql as $$
    begin
      raise exception 'audit_logs is append-only' using errcode = '42501';
    end;
    $$
  `.execute(db);
  await sql`
    create trigger trg_audit_logs_append_only
      before update or delete on audit_logs
      for each row execute function audit_logs_reject_change()
  `.execute(db);

  // Row-level security (DDD 15.3). Separate policies for writing and reading:
  // a login or a platform action has no Society and may still be written, but
  // only a caller's own Society's rows can be read back.
  await sql`alter table audit_logs enable row level security`.execute(db);
  await sql`alter table audit_logs force row level security`.execute(db);
  await sql`
    create policy audit_logs_insert on audit_logs for insert
      with check (
        society_id is null
        or (
          society_id = app_current_society_id()
          and (institution_id is null or institution_id = any (app_current_institution_ids()))
        )
      )
  `.execute(db);
  await sql`
    create policy audit_logs_select on audit_logs for select
      using (
        society_id = app_current_society_id()
        and (institution_id is null or institution_id = any (app_current_institution_ids()))
      )
  `.execute(db);

  // The foundation's default privileges give the app role every right on every
  // new table; the audit log gets only SELECT and INSERT.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke all on table audit_logs from erp_app;
        grant select, insert on table audit_logs to erp_app;
      end if;
    end;
    $$
  `.execute(db);

  // Partition upkeep (DDD 14.5). Creating a partition needs the table owner's
  // rights, which the app roles lack, so this function runs as its owner with a
  // fixed search_path. It holds no business rules. The caller passes the first
  // month so the schedule, not the database clock, decides.
  await sql`
    create function maintenance.ensure_audit_partitions(first_month date, months_ahead integer)
      returns integer
    language plpgsql
    security definer
    set search_path = pg_catalog, public
    as $$
    declare
      month_start date;
      part_name text;
      made integer := 0;
    begin
      if months_ahead < 0 or months_ahead > 24 then
        raise exception 'months_ahead must be between 0 and 24';
      end if;
      for i in 0..months_ahead loop
        month_start := (date_trunc('month', first_month) + make_interval(months => i))::date;
        part_name := format('audit_logs_%s', to_char(month_start, 'YYYY_MM'));
        if to_regclass(format('public.%I', part_name)) is null then
          execute format(
            'create table public.%I partition of public.audit_logs for values from (%L) to (%L)',
            part_name,
            to_char(month_start, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char((month_start + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
          -- Policies on the parent do not apply to a partition addressed by
          -- name, so the app role gets no rights on it at all.
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
  await sql`revoke all on function maintenance.ensure_audit_partitions(date, integer) from public`.execute(
    db,
  );
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke all on schema maintenance from erp_app;
        revoke all on function maintenance.ensure_audit_partitions(date, integer) from erp_app;
      end if;
      if exists (select 1 from pg_roles where rolname = 'erp_platform') then
        grant usage on schema maintenance to erp_platform;
        grant execute on function maintenance.ensure_audit_partitions(date, integer)
          to erp_platform;
      end if;
    end;
    $$
  `.execute(db);

  // Rows that fit no month land here; the upkeep job alarms if it holds any.
  await sql`create table audit_logs_default partition of audit_logs default`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke all on table audit_logs_default from erp_app;
      end if;
    end;
    $$
  `.execute(db);

  // This month and the next three (DDD 14.5: three months ahead).
  await sql`select maintenance.ensure_audit_partitions(current_date, 3)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists audit_logs cascade`.execute(db);
  await sql`drop function if exists audit_logs_reject_change()`.execute(db);
  await sql`drop function if exists maintenance.ensure_audit_partitions(date, integer)`.execute(db);
  await sql`drop schema if exists maintenance`.execute(db);
}
