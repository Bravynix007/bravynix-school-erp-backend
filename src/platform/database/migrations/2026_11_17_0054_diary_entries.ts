import { sql, type Kysely } from 'kysely';

/**
 * The diary (DDD 9.7, PRD 7.9): `diary_entries`, the homework or note a teacher writes for a section and subject on a
 * date.
 *
 * - The section is one of the Institution, the year one of the Institution, the subject one of the Society and the
 *   author (when there is one) a teacher whose home Institution this is (`uq_staff_members_id_home`), as for the
 *   timetable: extra Institutions are view-only, so a teacher never writes there. An admin with no staff record writes
 *   with no author. The description is never blank.
 * - The seven days back and the day not in the future are rules of the service (`MAX_BACKDATE_DAYS`), not of the table,
 *   because they depend on today.
 * - Institution-level row-level security (DDD 15.3). A parent reads the active entries of the section their child sits
 *   in now (`diary_entries_select_child`, through `student_section_placements` under its own child policy, which reads
 *   nothing of this table). The subjects and the teachers' names reach a parent the way the timetable gives them
 *   (`subjects_select_child`, `app_staff_names`, migration 0050). Soft delete only: the app role has no DELETE right.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table diary_entries (
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
      subject_id uuid not null,
      staff_member_id uuid,
      diary_date date not null,
      description varchar(2000) not null,
      constraint fk_diary_entries_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_diary_entries_year foreign key (academic_year_id, institution_id)
        references academic_years (id, institution_id) on delete restrict,
      constraint fk_diary_entries_section foreign key (section_id, institution_id)
        references sections (id, institution_id) on delete restrict,
      constraint fk_diary_entries_subject foreign key (subject_id, society_id)
        references subjects (id, society_id) on delete restrict,
      constraint fk_diary_entries_staff foreign key (staff_member_id, institution_id)
        references staff_members (id, home_institution_id) on delete restrict,
      constraint ck_diary_entries_status check (status in (0, 1)),
      constraint ck_diary_entries_description check (btrim(description) <> '')
    )
  `.execute(db);
  await sql`
    create index ix_diary_entries_section_date
      on diary_entries (section_id, academic_year_id, diary_date desc) where status = 1
  `.execute(db);
  await sql`
    create index ix_diary_entries_staff_date
      on diary_entries (staff_member_id, diary_date desc) where status = 1
  `.execute(db);
  await sql`
    create trigger trg_diary_entries_updated before update on diary_entries
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_diary_entries_version before update on diary_entries
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table diary_entries enable row level security`.execute(db);
  await sql`alter table diary_entries force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy diary_entries_select on diary_entries for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy diary_entries_insert on diary_entries for insert with check (${inScope})`.execute(
    db,
  );
  await sql`
    create policy diary_entries_update on diary_entries for update
      using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    create policy diary_entries_select_child on diary_entries for select using (
      app_current_role_code() = 5
      and status = 1
      and exists (
        select 1
        from student_section_placements p
        join student_enrolments e on e.id = p.student_enrolment_id
        where e.student_id = any (app_current_child_ids())
          and e.status = 1
          and p.end_date is null
          and p.section_id = diary_entries.section_id
      )
    )
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table diary_entries from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the school's diary lives here.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop diary_entries in production: it holds the school’s diary');
  }
  await sql`drop table if exists diary_entries`.execute(db);
}
