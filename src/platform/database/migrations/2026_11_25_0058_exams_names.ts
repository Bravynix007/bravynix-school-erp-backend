import { sql, type Kysely } from 'kysely';

/**
 * Exam names (DDD 9.7, PRD 7.11 step 1): `exams`, the exams of one Institution's academic year, such as "Unit Test 1".
 *
 * - An exam is a name (1 to 100), a type (1 Unit test, 2 Mid term, 3 Final, 4 Quarterly, 5 Half yearly, 6 Annual) and
 *   the dates it runs, the end on or after the start. The year is one of the same Institution (`fk_exams_year`), and
 *   `uq_exams_id_inst_year` is the target of the key that exam papers use to name an exam of their year (Phase 6 B3).
 * - Among a year's active exams no name repeats, in any letter case ("Exam name already exists").
 * - Institution-level row-level security (DDD 15.3): the caller's Society and one of the Institutions in scope. A
 *   parent reads the exam names of the Institution of one of the request's children (`app.child_ids`, through
 *   `students` under its own child policy, which reads nothing of this table). The parent also reads the academic
 *   years of that Institution, since the migration `timetable_time_slots` (`academic_years_select_child`). Soft delete
 *   only, so the app role has no DELETE right.
 * - The datesheet's publication stamp is added with the papers (Phase 6 B3), the first slice to use it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table exams (
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
      name varchar(100) not null,
      exam_type smallint not null,
      start_date date not null,
      end_date date not null,
      constraint fk_exams_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_exams_year foreign key (academic_year_id, institution_id)
        references academic_years (id, institution_id) on delete restrict,
      constraint uq_exams_id_inst_year unique (id, institution_id, academic_year_id),
      constraint ck_exams_status check (status in (0, 1)),
      constraint ck_exams_name check (btrim(name) <> ''),
      constraint ck_exams_type check (exam_type between 1 and 6),
      constraint ck_exams_dates check (end_date >= start_date)
    )
  `.execute(db);
  await sql`
    create unique index uq_exams_year_name on exams (academic_year_id, lower(name)) where status = 1
  `.execute(db);
  await sql`
    create trigger trg_exams_updated before update on exams
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_exams_version before update on exams
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table exams enable row level security`.execute(db);
  await sql`alter table exams force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy exams_select on exams for select using (${inScope})`.execute(db);
  await sql`create policy exams_insert on exams for insert with check (${inScope})`.execute(db);
  await sql`
    create policy exams_update on exams for update using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    create policy exams_select_child on exams for select using (
      app_current_role_code() = 5
      and status = 1
      and exists (
        select 1 from students s
        where s.id = any (app_current_child_ids())
          and s.institution_id = exams.institution_id
      )
    )
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table exams from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the school's exams live here.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop exams in production: it holds the schools’ exams');
  }
  await sql`drop table if exists exams`.execute(db);
}
