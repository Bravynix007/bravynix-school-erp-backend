import { sql, type Kysely } from 'kysely';

/**
 * People, part 11 (DDD 9.12, API design 10.8): one student CSV import and its result.
 *
 * - `import_runs`: the file, the academic year the students join, the run's progress and what it found. `run_status`
 *   is 1 Queued, 2 Running, 3 Completed, 4 Failed (a failed run carries `error_code`, the reason no row was read:
 *   a bad header, too many rows). The worker settles the file 100 rows at a time and moves `processed_rows` in the same
 *   transaction as the students it made, so a worker that dies resumes after the last batch and never repeats one.
 *   `row_errors` keeps the first 1,000 rows that were skipped, `{ row, message }`; `skipped_rows` counts them all.
 *   `over_capacity` says a section now holds more students than its capacity (a warning, PRD 7.3). Beyond the DDD
 *   columns: `academic_year_id`, `processed_rows`, `over_capacity`, `error_code`.
 * - One run at a time for an Institution (`uq_import_runs_running`, API design 16.3). A run and its file are removed
 *   after 7 days; the sweep that does it comes with the worker's sweeps.
 * - Institution-level row-level security (DDD 15.3). The app role may change the run's progress columns only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table import_runs (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      society_id uuid not null,
      institution_id uuid not null,
      import_type smallint not null default 1,
      file_id uuid not null references files (id) on delete restrict,
      academic_year_id uuid not null,
      run_status smallint not null default 1,
      total_rows integer,
      imported_rows integer not null default 0,
      skipped_rows integer not null default 0,
      processed_rows integer not null default 0,
      row_errors jsonb not null default '[]',
      over_capacity boolean not null default false,
      error_code varchar(40),
      started_at timestamptz,
      finished_at timestamptz,
      constraint fk_import_runs_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_import_runs_year foreign key (academic_year_id, institution_id)
        references academic_years (id, institution_id) on delete restrict,
      constraint ck_import_runs_type check (import_type = 1),
      constraint ck_import_runs_status check (run_status in (1, 2, 3, 4)),
      constraint ck_import_runs_progress check (
        imported_rows >= 0 and skipped_rows >= 0 and processed_rows = imported_rows + skipped_rows
        and (total_rows is null or processed_rows <= total_rows)
      ),
      constraint ck_import_runs_errors check (jsonb_typeof(row_errors) = 'array'),
      constraint ck_import_runs_failure check ((run_status = 4) = (error_code is not null)),
      constraint ck_import_runs_finished check ((run_status in (3, 4)) = (finished_at is not null))
    )
  `.execute(db);
  await sql`
    create unique index uq_import_runs_running on import_runs (institution_id) where run_status in (1, 2)
  `.execute(db);
  await sql`
    create index ix_import_runs_institution on import_runs (institution_id, created_at desc)
  `.execute(db);

  const runs = sql.table('import_runs');
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`alter table ${runs} enable row level security`.execute(db);
  await sql`alter table ${runs} force row level security`.execute(db);
  await sql`create policy import_runs_select on ${runs} for select using (${inScope})`.execute(db);
  await sql`
    create policy import_runs_insert on ${runs} for insert with check (${inScope})
  `.execute(db);
  await sql`
    create policy import_runs_update on ${runs} for update using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, delete, truncate on table import_runs from erp_app;
        grant update (run_status, total_rows, imported_rows, skipped_rows, processed_rows, row_errors,
          over_capacity, error_code, started_at, finished_at) on table import_runs to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): a run is the record of what an import did.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop import runs in production');
  }
  await sql`drop table if exists import_runs`.execute(db);
}
