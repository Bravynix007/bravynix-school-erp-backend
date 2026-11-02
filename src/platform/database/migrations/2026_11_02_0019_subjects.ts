import { sql, type Kysely } from 'kysely';

/**
 * Subjects (DDD 9.4, PRD 7.4): one list per Society, shared by its Institutions, so the table carries `society_id`
 * only. A name is unique among the Society's active subjects, and so is a code where there is one (both ignoring
 * letter case); a deactivated subject frees them. `uq_subjects_id_society` is the target of the keys later tables
 * use to name a subject of the same Society.
 *
 * Society-level row-level security (DDD 15.3): the caller's Society. Soft delete only, so the app role has no
 * DELETE right.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table subjects (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      society_id uuid not null references societies (id) on delete restrict,
      name varchar(100) not null,
      code varchar(50),
      constraint uq_subjects_id_society unique (id, society_id),
      constraint ck_subjects_status check (status in (0, 1)),
      constraint ck_subjects_name check (btrim(name) <> ''),
      constraint ck_subjects_code check (code is null or btrim(code) <> '')
    )
  `.execute(db);
  await sql`
    create unique index uq_subjects_society_name on subjects (society_id, lower(name)) where status = 1
  `.execute(db);
  await sql`
    create unique index uq_subjects_society_code
      on subjects (society_id, lower(code)) where code is not null and status = 1
  `.execute(db);

  await sql`
    create trigger trg_subjects_updated before update on subjects
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_subjects_version before update on subjects
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table subjects enable row level security`.execute(db);
  await sql`alter table subjects force row level security`.execute(db);
  await sql`create policy subjects_select on subjects for select using (society_id = app_current_society_id())`.execute(
    db,
  );
  await sql`create policy subjects_insert on subjects for insert with check (society_id = app_current_society_id())`.execute(
    db,
  );
  await sql`
    create policy subjects_update on subjects for update
      using (society_id = app_current_society_id()) with check (society_id = app_current_society_id())
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table subjects from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): teaching records will refer to a subject.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop subjects in production: later tables refer to it');
  }
  await sql`drop table if exists subjects`.execute(db);
}
