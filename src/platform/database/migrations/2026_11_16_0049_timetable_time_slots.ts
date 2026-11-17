import { sql, type Kysely } from 'kysely';

/**
 * Period timings (DDD 9.4, PRD 7.8): `time_slots`, the periods of one Institution's academic year (D-03: one set of
 * timings per Institution and year).
 *
 * - A period has a number (1 to 30), a label, a start and an end (`end_time > start_time`), and says whether it is a
 *   break. The year is one of the same Institution (`fk_time_slots_year`), and `uq_time_slots_id_year` is the target
 *   of the key that timetable entries use to name a period of their year.
 * - Among the active periods of a year no number repeats and no two periods overlap. The overlap is a gist exclusion
 *   (as for academic years, from the `btree_gist` extension of the foundation), so two admins saving at once cannot
 *   both succeed; a period may end when the next begins. `uq_time_slots_year_start` is the DDD's own index: two
 *   periods with one start overlap, so the exclusion refuses them as well.
 * - Institution-level row-level security (DDD 15.3): the caller's Society and one of the Institutions in scope. A
 *   parent reads the periods of the Institution of one of the request's children (the `app.child_ids` setting that
 *   `ChildAccess` sets after it has checked the link), through `students` under its own child policy, which reads
 *   nothing of this table. Soft delete only, so the app role has no DELETE right.
 * - `academic_years_select_child`: the same parent reads the academic years of their child's Institution, so the
 *   current year (the one the timings belong to unless another is named) can be found for them. Read only, and no
 *   policy of `students` reads `academic_years`, so there is no recursion.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table time_slots (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid not null,
      academic_year_id uuid not null,
      period_no smallint not null,
      label varchar(100),
      start_time time not null,
      end_time time not null,
      is_break boolean not null default false,
      constraint fk_time_slots_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_time_slots_year foreign key (academic_year_id, institution_id)
        references academic_years (id, institution_id) on delete restrict,
      constraint uq_time_slots_id_year unique (id, academic_year_id),
      constraint ck_time_slots_status check (status in (0, 1)),
      constraint ck_time_slots_period_no check (period_no between 1 and 30),
      constraint ck_time_slots_label check (label is null or btrim(label) <> ''),
      constraint ck_time_slots_times check (end_time > start_time),
      constraint ex_time_slots_no_overlap exclude using gist (
        academic_year_id with =,
        tsrange(date '2000-01-01' + start_time, date '2000-01-01' + end_time) with &&
      ) where (status = 1)
    )
  `.execute(db);
  await sql`
    create unique index uq_time_slots_year_period on time_slots (academic_year_id, period_no)
      where status = 1
  `.execute(db);
  await sql`
    create unique index uq_time_slots_year_start on time_slots (academic_year_id, start_time)
      where status = 1
  `.execute(db);
  await sql`
    create trigger trg_time_slots_updated before update on time_slots
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_time_slots_version before update on time_slots
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table time_slots enable row level security`.execute(db);
  await sql`alter table time_slots force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy time_slots_select on time_slots for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy time_slots_insert on time_slots for insert with check (${inScope})`.execute(
    db,
  );
  await sql`
    create policy time_slots_update on time_slots for update using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    create policy time_slots_select_child on time_slots for select using (
      app_current_role_code() = 5
      and status = 1
      and exists (
        select 1 from students s
        where s.id = any (app_current_child_ids())
          and s.institution_id = time_slots.institution_id
      )
    )
  `.execute(db);
  await sql`
    create policy academic_years_select_child on academic_years for select using (
      app_current_role_code() = 5
      and exists (
        select 1 from students s
        where s.id = any (app_current_child_ids())
          and s.institution_id = academic_years.institution_id
      )
    )
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table time_slots from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the school's period timings live here.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop time_slots in production: it holds the period timings');
  }
  await sql`drop policy if exists academic_years_select_child on academic_years`.execute(db);
  await sql`drop table if exists time_slots`.execute(db);
}
