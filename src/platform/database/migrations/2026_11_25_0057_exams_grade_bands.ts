import { sql, type Kysely } from 'kysely';

/**
 * Grade bands (DDD 9.7, PRD 7.11 step 7): `grade_bands`, the grades of one Institution, each a range of percentages.
 *
 * - Per Institution, with no academic year (PRD 7.11: "grade bands per Institution"; the DDD's unique index and overlap
 *   rule are per Institution too, Phase 6 decision 3). A change never touches a published result, because publishing
 *   freezes the grade name (DDD 9.7 `published_results`).
 * - A band is a name (A1), a minimum and a maximum percentage (two decimals, `0 <= min <= max <= 100`), an optional
 *   grade point (0 to 10) and description. Among an Institution's active bands no name repeats (any letter case) and no
 *   two ranges share a value: both ends belong to the band (`[]`), so 81 to 90.99 and 91 to 100 sit side by side, and
 *   81 to 91 and 91 to 100 overlap. The overlap is a gist exclusion (`btree_gist`, as for academic years and time
 *   slots), so two admins saving at once cannot both succeed.
 * - Institution-level row-level security (DDD 15.3). A parent reads the active bands of the Institution of one of the
 *   request's children (`app.child_ids`, through `students` under its own child policy, which reads nothing of this
 *   table), so the child's grade can be shown beside the scale. Soft delete only: the app role has no DELETE right.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table grade_bands (
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
      min_percentage numeric(5, 2) not null,
      max_percentage numeric(5, 2) not null,
      grade_point numeric(4, 2),
      description varchar(100),
      constraint fk_grade_bands_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint ck_grade_bands_status check (status in (0, 1)),
      constraint ck_grade_bands_name check (btrim(name) <> ''),
      constraint ck_grade_bands_description check (description is null or btrim(description) <> ''),
      constraint ck_grade_bands_range check (
        min_percentage >= 0 and min_percentage <= max_percentage and max_percentage <= 100
      ),
      constraint ck_grade_bands_grade_point check (grade_point is null or grade_point between 0 and 10),
      constraint ex_grade_bands_no_overlap exclude using gist (
        institution_id with =,
        numrange(min_percentage, max_percentage, '[]') with &&
      ) where (status = 1)
    )
  `.execute(db);
  await sql`
    create unique index uq_grade_bands_institution_name on grade_bands (institution_id, lower(name))
      where status = 1
  `.execute(db);
  await sql`
    create trigger trg_grade_bands_updated before update on grade_bands
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_grade_bands_version before update on grade_bands
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table grade_bands enable row level security`.execute(db);
  await sql`alter table grade_bands force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy grade_bands_select on grade_bands for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy grade_bands_insert on grade_bands for insert with check (${inScope})`.execute(
    db,
  );
  await sql`
    create policy grade_bands_update on grade_bands for update using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    create policy grade_bands_select_child on grade_bands for select using (
      app_current_role_code() = 5
      and status = 1
      and exists (
        select 1 from students s
        where s.id = any (app_current_child_ids())
          and s.institution_id = grade_bands.institution_id
      )
    )
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table grade_bands from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the schools' grading scales live here.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop grade_bands in production: it holds the grading scales');
  }
  await sql`drop table if exists grade_bands`.execute(db);
}
