import { sql, type Kysely } from 'kysely';

/**
 * People, part 10 (DDD 9.6, PRD 7.6): the stars a teacher or an admin gives a student.
 *
 * - `student_achievements`: one row per star, tied to the student's enrolment for a year (a mark, a star and a fee
 *   account follow the enrolment, DDD M4), so the year is kept with it. `tier` 1 Silver, 2 Gold, 3 Platinum and a
 *   description; `awarded_by_staff_member_id` is the staff record that gave it and is empty when a Society Owner did.
 *   `created_at` is the date and time shown. A star is removed by `status` 0, never deleted.
 * - Institution-level row-level security (DDD 15.3). The app role may change only `status`, `updated_at` and
 *   `updated_by`: nothing else about a star is edited, and none is deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table student_achievements (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      status smallint not null default 1,
      society_id uuid not null,
      institution_id uuid not null,
      academic_year_id uuid not null,
      student_enrolment_id uuid not null,
      tier smallint not null,
      description varchar(500) not null,
      awarded_by_staff_member_id uuid,
      constraint fk_student_achievements_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_student_achievements_enrolment foreign key (student_enrolment_id, institution_id)
        references student_enrolments (id, institution_id) on delete restrict,
      constraint fk_student_achievements_enrolment_year foreign key (student_enrolment_id, academic_year_id)
        references student_enrolments (id, academic_year_id) on delete restrict,
      constraint fk_student_achievements_staff foreign key (awarded_by_staff_member_id, society_id)
        references staff_members (id, society_id) on delete restrict,
      constraint ck_student_achievements_status check (status in (0, 1)),
      constraint ck_student_achievements_tier check (tier in (1, 2, 3)),
      constraint ck_student_achievements_description check (btrim(description) <> '')
    )
  `.execute(db);
  await sql`
    create index ix_student_achievements_enrolment
      on student_achievements (student_enrolment_id, created_at desc) where status = 1
  `.execute(db);
  await sql`
    create trigger trg_student_achievements_updated before update on student_achievements
      for each row execute function set_updated_at()
  `.execute(db);

  const achievements = sql.table('student_achievements');
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`alter table ${achievements} enable row level security`.execute(db);
  await sql`alter table ${achievements} force row level security`.execute(db);
  await sql`
    create policy student_achievements_select on ${achievements} for select using (${inScope})
  `.execute(db);
  await sql`
    create policy student_achievements_insert on ${achievements} for insert with check (${inScope})
  `.execute(db);
  await sql`
    create policy student_achievements_update on ${achievements} for update
      using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, delete, truncate on table student_achievements from erp_app;
        grant update (status, updated_at, updated_by) on table student_achievements to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the AI summary and the parent's home card read these rows.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop student achievements in production');
  }
  await sql`drop table if exists student_achievements`.execute(db);
}
