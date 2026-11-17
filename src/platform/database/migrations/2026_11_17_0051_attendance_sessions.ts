import { sql, type Kysely } from 'kysely';

/**
 * Attendance, part 1 (DDD 9.7, 13.2; PRD 7.7, decision 29): `attendance_sessions` and `attendance_exceptions`.
 *
 * - `attendance_sessions`: one marking of one section on one date, with the counts the home card shows, so "Present:
 *   x / y" never scans marks. V1 takes attendance once a day: `attendance_mode` is 2, and the period and the subject
 *   stay empty (a check ties the period to the Period mode, kept for later). One active session a section and day (a
 *   unique index, so two teachers submitting at once cannot both win). `present_count` is stored and generated from
 *   the other counts. `taken_by_staff_member_id` is the home-Institution teacher who marked it, and empty when an
 *   admin without a staff record did. Policies as for every Institution table; there is no DELETE right, a session is
 *   voided by `status` 0.
 * - `attendance_exceptions`: only the students who were not Present (Absent, Late, Half day, Leave). It has no
 *   Society and no ID of its own, to stay small (DDD 9.7), so its policy reads the Institution alone. Partitioned by
 *   `attendance_date`, one partition for each calendar year, and a DEFAULT partition that must stay empty: the
 *   worker's sweep keeps the next year made ahead. A date is the session's date by the composite key.
 * - `maintenance.ensure_attendance_partitions(first_year, years_ahead)`: makes the yearly partitions, and takes every
 *   right on each from the app role, because the policies of the parent do not reach a partition that is named. It
 *   runs as its owner with a fixed search_path and holds no business rule.
 *
 * Correcting a session (B7) adds the UPDATE and DELETE policies of the exceptions with the code that needs them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table attendance_sessions (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      society_id uuid not null,
      institution_id uuid not null,
      academic_year_id uuid not null,
      section_id uuid not null,
      attendance_date date not null,
      attendance_mode smallint not null default 2,
      time_slot_id uuid,
      subject_id uuid,
      taken_by_staff_member_id uuid,
      roster_count smallint not null,
      absent_count smallint not null default 0,
      late_count smallint not null default 0,
      half_day_count smallint not null default 0,
      leave_count smallint not null default 0,
      present_count smallint generated always as
        (roster_count - absent_count - late_count - half_day_count - leave_count) stored,
      submitted_at timestamptz not null default now(),
      submitted_by uuid not null references users (id),
      last_corrected_at timestamptz,
      last_corrected_by uuid references users (id),
      constraint fk_attendance_sessions_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_attendance_sessions_year foreign key (academic_year_id, institution_id)
        references academic_years (id, institution_id) on delete restrict,
      constraint fk_attendance_sessions_section foreign key (section_id, institution_id)
        references sections (id, institution_id) on delete restrict,
      constraint fk_attendance_sessions_slot foreign key (time_slot_id, academic_year_id)
        references time_slots (id, academic_year_id) on delete restrict,
      constraint fk_attendance_sessions_subject foreign key (subject_id, society_id)
        references subjects (id, society_id) on delete restrict,
      constraint fk_attendance_sessions_staff foreign key (taken_by_staff_member_id, institution_id)
        references staff_members (id, home_institution_id) on delete restrict,
      constraint ck_attendance_sessions_status check (status in (0, 1)),
      constraint ck_attendance_sessions_mode check (attendance_mode in (1, 2)),
      constraint ck_attendance_sessions_period check ((time_slot_id is not null) = (attendance_mode = 1)),
      constraint ck_attendance_sessions_roster check (roster_count >= 0),
      constraint ck_attendance_sessions_counts check (
        absent_count >= 0 and late_count >= 0 and half_day_count >= 0 and leave_count >= 0
        and absent_count + late_count + half_day_count + leave_count <= roster_count
      )
    ) with (fillfactor = 90)
  `.execute(db);
  await sql`
    create unique index uq_attendance_sessions_period
      on attendance_sessions (section_id, attendance_date, time_slot_id)
      where status = 1 and time_slot_id is not null
  `.execute(db);
  await sql`
    create unique index uq_attendance_sessions_daily
      on attendance_sessions (section_id, attendance_date)
      where status = 1 and time_slot_id is null
  `.execute(db);
  await sql`
    create unique index uq_attendance_sessions_id_inst_date
      on attendance_sessions (id, institution_id, attendance_date)
  `.execute(db);
  await sql`
    create index ix_attendance_sessions_institution_date
      on attendance_sessions (institution_id, attendance_date) where status = 1
  `.execute(db);
  await sql`
    create trigger trg_attendance_sessions_updated before update on attendance_sessions
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_attendance_sessions_version before update on attendance_sessions
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table attendance_sessions enable row level security`.execute(db);
  await sql`alter table attendance_sessions force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy attendance_sessions_select on attendance_sessions for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy attendance_sessions_insert on attendance_sessions for insert with check (${inScope})`.execute(
    db,
  );
  await sql`
    create policy attendance_sessions_update on attendance_sessions for update
      using (${inScope}) with check (${inScope})
  `.execute(db);

  await sql`
    create table attendance_exceptions (
      attendance_session_id uuid not null,
      student_enrolment_id uuid not null,
      attendance_date date not null,
      institution_id uuid not null,
      attendance_status smallint not null,
      corrected_at timestamptz,
      corrected_by uuid references users (id),
      constraint pk_attendance_exceptions
        primary key (attendance_session_id, student_enrolment_id, attendance_date),
      constraint fk_attendance_exceptions_session
        foreign key (attendance_session_id, institution_id, attendance_date)
        references attendance_sessions (id, institution_id, attendance_date) on delete restrict,
      constraint fk_attendance_exceptions_enrolment foreign key (student_enrolment_id, institution_id)
        references student_enrolments (id, institution_id) on delete restrict,
      constraint ck_attendance_exceptions_status check (attendance_status in (2, 3, 4, 5))
    ) partition by range (attendance_date)
  `.execute(db);
  await sql`
    create index ix_attendance_exceptions_enrolment_date
      on attendance_exceptions (student_enrolment_id, attendance_date) include (attendance_status)
  `.execute(db);
  await sql`alter table attendance_exceptions enable row level security`.execute(db);
  await sql`alter table attendance_exceptions force row level security`.execute(db);
  await sql`
    create policy attendance_exceptions_select on attendance_exceptions for select
      using (institution_id = any (app_current_institution_ids()))
  `.execute(db);
  await sql`
    create policy attendance_exceptions_insert on attendance_exceptions for insert
      with check (institution_id = any (app_current_institution_ids()))
  `.execute(db);

  // A date no partition covers lands here, and the sweep and the reconciliation treat a row here as a fault.
  await sql`create table attendance_exceptions_default partition of attendance_exceptions default`.execute(
    db,
  );
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke all on table public.attendance_exceptions_default from erp_app;
        revoke delete, truncate on table public.attendance_sessions from erp_app;
        revoke delete, truncate on table public.attendance_exceptions from erp_app;
      end if;
    end;
    $$
  `.execute(db);

  await sql`create schema if not exists maintenance`.execute(db);
  await sql`
    create function maintenance.ensure_attendance_partitions(first_year integer, years_ahead integer)
      returns integer
    language plpgsql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
    declare
      part_name text;
      made integer := 0;
    begin
      if first_year < 2000 or first_year > 2200 then
        raise exception 'first_year must be between 2000 and 2200';
      end if;
      if years_ahead < 0 or years_ahead > 5 then
        raise exception 'years_ahead must be between 0 and 5';
      end if;
      for i in 0..years_ahead loop
        part_name := format('attendance_exceptions_%s', first_year + i);
        if to_regclass(format('public.%I', part_name)) is null then
          execute format(
            'create table public.%I partition of public.attendance_exceptions for values from (%L) to (%L)',
            part_name, make_date(first_year + i, 1, 1), make_date(first_year + i + 1, 1, 1)
          );
          -- A policy on the parent does not apply to a partition addressed by name, so the app role gets no rights
          -- on it at all (as for the inboxes' and the audit log's partitions).
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
  await sql`revoke all on function maintenance.ensure_attendance_partitions(integer, integer) from public`.execute(
    db,
  );
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant usage on schema maintenance to erp_app;
        grant execute on function maintenance.ensure_attendance_partitions(integer, integer) to erp_app;
      end if;
    end;
    $$
  `.execute(db);

  // This year and the next, as the sweep keeps them (DDD 14.5).
  await sql`
    select maintenance.ensure_attendance_partitions(extract(year from current_date)::integer, 1)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): attendance is the school's record.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop attendance in production: it holds the school’s record');
  }
  await sql`drop function if exists maintenance.ensure_attendance_partitions(integer, integer)`.execute(
    db,
  );
  await sql`drop table if exists attendance_exceptions`.execute(db);
  await sql`drop table if exists attendance_sessions`.execute(db);
}
