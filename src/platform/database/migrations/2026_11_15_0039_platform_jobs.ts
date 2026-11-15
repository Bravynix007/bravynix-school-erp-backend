import { sql, type Kysely } from 'kysely';

/**
 * The job queue the worker runs (SDD 11.2, plan decision 5): one table, and three maintenance functions the worker
 * calls to claim a job, keep its lease and settle it.
 *
 * - `jobs`: a unit of background work, written in the same transaction as the change that asks for it (an import
 *   run, later fan-outs and PDFs). `kind` names its handler; `payload` carries what the handler needs and never
 *   personal data. A job belongs to a Society and, when the work is one Institution's, to that Institution: the
 *   tenant the worker acts in. `job_status` is 1 Queued, 2 Running, 3 Done, 4 Failed. A Running job holds a lease
 *   (`locked_until`); a worker that dies leaves it to run out, and the next claim resumes the job (`attempts` counts
 *   the claims).
 * - Row-level security is forced, as on every tenant table (DDD 15.3). The app role may insert a job for its own
 *   Society and Institutions and read them, and never changes one except through the functions below. Those run as
 *   the table owner, whom the forced policies would bind too, so one more policy admits the owner role and no
 *   other. The claim takes the oldest due job with `for update skip locked`, so two workers never hold the same one.
 *   `extend_job` keeps the lease while a handler works, `settle_job` ends the job (Done or Failed) and `retry_job`
 *   queues it again after a pause, for work that stopped on a passing fault.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table jobs (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid,
      kind varchar(40) not null,
      payload jsonb not null default '{}',
      job_status smallint not null default 1,
      run_at timestamptz not null default now(),
      attempts integer not null default 0,
      locked_until timestamptz,
      finished_at timestamptz,
      last_error varchar(500),
      constraint fk_jobs_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint ck_jobs_status check (job_status in (1, 2, 3, 4)),
      constraint ck_jobs_lease check ((job_status = 2) = (locked_until is not null)),
      constraint ck_jobs_finished check ((job_status in (3, 4)) = (finished_at is not null))
    )
  `.execute(db);
  await sql`
    create index ix_jobs_due on jobs (run_at, created_at) where job_status in (1, 2)
  `.execute(db);
  await sql`
    create trigger trg_jobs_updated before update on jobs
      for each row execute function set_updated_at()
  `.execute(db);

  const jobs = sql.table('jobs');
  await sql`alter table ${jobs} enable row level security`.execute(db);
  await sql`alter table ${jobs} force row level security`.execute(db);
  await sql`
    create policy jobs_select on ${jobs} for select using (
      society_id = app_current_society_id()
      and (institution_id is null or institution_id = any (app_current_institution_ids()))
    )
  `.execute(db);
  await sql`
    create policy jobs_insert on ${jobs} for insert with check (
      society_id = app_current_society_id()
      and (institution_id is null or institution_id = any (app_current_institution_ids()))
    )
  `.execute(db);
  // The functions below run as the role that owns the table: forced row-level security binds it, so it is named.
  await sql`
    do $$
    begin
      execute format('create policy jobs_worker on public.jobs for all to %I using (true) with check (true)', current_user);
    end;
    $$
  `.execute(db);

  await sql`
    create function maintenance.claim_job(p_lease_seconds integer)
    returns table (
      id uuid, kind varchar, society_id uuid, institution_id uuid, created_by uuid, payload jsonb, attempts integer
    )
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      update public.jobs j
         set job_status = 2,
             attempts = j.attempts + 1,
             locked_until = now() + make_interval(secs => p_lease_seconds)
       where j.id = (
         select c.id from public.jobs c
          where (c.job_status = 1 and c.run_at <= now())
             or (c.job_status = 2 and c.locked_until < now())
          order by c.run_at, c.created_at
          limit 1
          for update skip locked
       )
      returning j.id, j.kind, j.society_id, j.institution_id, j.created_by, j.payload, j.attempts
    $$
  `.execute(db);
  await sql`
    create function maintenance.extend_job(p_id uuid, p_lease_seconds integer) returns boolean
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      with held as (
        update public.jobs
           set locked_until = now() + make_interval(secs => p_lease_seconds)
         where id = p_id and job_status = 2 and locked_until >= now()
        returning 1
      )
      select exists (select 1 from held)
    $$
  `.execute(db);
  await sql`
    create function maintenance.settle_job(p_id uuid, p_status smallint, p_error text) returns boolean
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      with settled as (
        update public.jobs
           set job_status = p_status,
               locked_until = null,
               finished_at = now(),
               last_error = left(p_error, 500)
         where id = p_id and job_status = 2 and p_status in (3, 4)
        returning 1
      )
      select exists (select 1 from settled)
    $$
  `.execute(db);
  await sql`
    create function maintenance.retry_job(p_id uuid, p_delay_seconds integer, p_error text) returns boolean
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      with queued as (
        update public.jobs
           set job_status = 1,
               locked_until = null,
               run_at = now() + make_interval(secs => p_delay_seconds),
               last_error = left(p_error, 500)
         where id = p_id and job_status = 2
        returning 1
      )
      select exists (select 1 from queued)
    $$
  `.execute(db);
  for (const signature of [
    'claim_job(integer)',
    'extend_job(uuid, integer)',
    'settle_job(uuid, smallint, text)',
    'retry_job(uuid, integer, text)',
  ]) {
    await sql`revoke all on function ${sql.raw(`maintenance.${signature}`)} from public`.execute(
      db,
    );
  }
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, delete, truncate on table jobs from erp_app;
        grant usage on schema maintenance to erp_app;
        grant execute on function maintenance.claim_job(integer) to erp_app;
        grant execute on function maintenance.extend_job(uuid, integer) to erp_app;
        grant execute on function maintenance.settle_job(uuid, smallint, text) to erp_app;
        grant execute on function maintenance.retry_job(uuid, integer, text) to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): a queued job is work somebody asked for.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the job queue in production');
  }
  await sql`drop function if exists maintenance.retry_job(uuid, integer, text)`.execute(db);
  await sql`drop function if exists maintenance.settle_job(uuid, smallint, text)`.execute(db);
  await sql`drop function if exists maintenance.extend_job(uuid, integer)`.execute(db);
  await sql`drop function if exists maintenance.claim_job(integer)`.execute(db);
  await sql`drop table if exists jobs`.execute(db);
}
