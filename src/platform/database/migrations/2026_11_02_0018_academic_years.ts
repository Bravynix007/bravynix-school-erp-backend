import { sql, type Kysely } from 'kysely';

/**
 * Academic years (DDD 9.4, PRD 7.2): the years of one Institution. The rules live in the database as well as
 * the service, so no race can break them: one current year (partial unique), no two active years that overlap
 * (a gist exclusion, from the `btree_gist` extension of the foundation), a name unique among active years, and
 * the current year cannot be deactivated.
 *
 * Institution-level row-level security (DDD 15.3): the caller's Society and one of the Institutions in scope.
 * Soft delete only, so the app role has no DELETE right. `uq_academic_years_id_institution` is the target of
 * the keys that later tables use to name a year of the same Institution.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table academic_years (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid not null,
      name varchar(20) not null,
      start_date date not null,
      end_date date not null,
      is_current boolean not null default false,
      constraint fk_academic_years_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint uq_academic_years_id_institution unique (id, institution_id),
      constraint ck_academic_years_status check (status in (0, 1)),
      constraint ck_academic_years_name check (btrim(name) <> ''),
      constraint ck_academic_years_dates check (end_date > start_date),
      constraint ck_academic_years_current_not_deleted check (not (is_current and status = 0)),
      constraint ex_academic_years_no_overlap exclude using gist (
        institution_id with =,
        daterange(start_date, end_date, '[]') with &&
      ) where (status = 1)
    )
  `.execute(db);
  await sql`
    create unique index uq_academic_years_institution_name
      on academic_years (institution_id, lower(name)) where status = 1
  `.execute(db);
  await sql`
    create unique index uq_academic_years_current
      on academic_years (institution_id) where is_current and status = 1
  `.execute(db);

  await sql`
    create trigger trg_academic_years_updated before update on academic_years
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_academic_years_version before update on academic_years
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table academic_years enable row level security`.execute(db);
  await sql`alter table academic_years force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy academic_years_select on academic_years for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy academic_years_insert on academic_years for insert with check (${inScope})`.execute(
    db,
  );
  await sql`
    create policy academic_years_update on academic_years for update
      using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table academic_years from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): a year is referenced by everything dated.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop academic_years in production: later tables refer to it');
  }
  await sql`drop table if exists academic_years`.execute(db);
}
