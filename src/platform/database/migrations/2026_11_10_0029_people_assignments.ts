import { sql, type Kysely } from 'kysely';

/**
 * People, part 4 (DDD 9.4, PRD 7.5, decision 11): who leads and who teaches which section.
 *
 * - `class_teacher_assignments`: the class teacher of a section for one academic year. One class teacher a section
 *   and one section a class teacher, among the active rows of a year (`uq_class_teacher_section`,
 *   `uq_class_teacher_staff`), so no race can give a section two leaders.
 * - `teaching_assignments`: which section and subject a teacher teaches in a year. More than one teacher a section
 *   and subject is allowed; the same teacher twice is not.
 *
 * Both rows belong to the staff member's home Institution: `fk_..._staff` points at `uq_staff_members_id_home`, so a
 * teacher cannot be assigned at an Institution that is only an extra one (extra Institutions are view-only, PRD 4).
 * The year, the section and the subject are checked by composite keys to the same Institution or Society.
 *
 * The tables are insert-only apart from ending a row: `ended_at` and `ended_by` are set together, and the app role
 * may update nothing else (a column grant), nor delete. Institution-level row-level security (DDD 15.3). Ending keeps
 * the row as history; a new assignment is a new row.
 */

/** The keys and the check every assignment table has, named for the table. */
const keys = (table: string) => sql`
      constraint ${sql.id(`fk_${table}_institution`)} foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint ${sql.id(`fk_${table}_year`)} foreign key (academic_year_id, institution_id)
        references academic_years (id, institution_id) on delete restrict,
      constraint ${sql.id(`fk_${table}_section`)} foreign key (section_id, institution_id)
        references sections (id, institution_id) on delete restrict,
      constraint ${sql.id(`fk_${table}_staff`)} foreign key (staff_member_id, institution_id)
        references staff_members (id, home_institution_id) on delete restrict,
      constraint ${sql.id(`ck_${table}_ended`)} check ((ended_at is null) = (ended_by is null))
  `;

export async function up(db: Kysely<unknown>): Promise<void> {
  const common = sql`
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      society_id uuid not null,
      institution_id uuid not null,
      academic_year_id uuid not null,
      section_id uuid not null,
      staff_member_id uuid not null,
      ended_at timestamptz,
      ended_by uuid references users (id)
  `;
  await sql`
    create table class_teacher_assignments (
      ${common},
      ${keys('class_teacher_assignments')}
    )
  `.execute(db);
  await sql`
    create unique index uq_class_teacher_section
      on class_teacher_assignments (academic_year_id, section_id) where ended_at is null
  `.execute(db);
  await sql`
    create unique index uq_class_teacher_staff
      on class_teacher_assignments (academic_year_id, staff_member_id) where ended_at is null
  `.execute(db);
  await sql`
    create index ix_class_teacher_staff
      on class_teacher_assignments (staff_member_id, academic_year_id) where ended_at is null
  `.execute(db);

  await sql`
    create table teaching_assignments (
      ${common},
      subject_id uuid not null,
      constraint fk_teaching_assignments_subject foreign key (subject_id, society_id)
        references subjects (id, society_id) on delete restrict,
      ${keys('teaching_assignments')}
    )
  `.execute(db);
  await sql`
    create unique index uq_teaching_assignments_active
      on teaching_assignments (academic_year_id, section_id, subject_id, staff_member_id)
      where ended_at is null
  `.execute(db);
  await sql`
    create index ix_teaching_assignments_staff
      on teaching_assignments (staff_member_id, academic_year_id) where ended_at is null
  `.execute(db);
  await sql`
    create index ix_teaching_assignments_section
      on teaching_assignments (section_id, academic_year_id) where ended_at is null
  `.execute(db);

  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  for (const table of ['class_teacher_assignments', 'teaching_assignments']) {
    const name = sql.table(table);
    const policy = (suffix: string) => sql.id(`${table}_${suffix}`);
    await sql`alter table ${name} enable row level security`.execute(db);
    await sql`alter table ${name} force row level security`.execute(db);
    await sql`create policy ${policy('select')} on ${name} for select using (${inScope})`.execute(
      db,
    );
    await sql`create policy ${policy('insert')} on ${name} for insert with check (${inScope})`.execute(
      db,
    );
    await sql`
      create policy ${policy('update')} on ${name} for update
        using (${inScope}) with check (${inScope})
    `.execute(db);
  }
  // A row is never edited or deleted: ending it sets the two `ended_*` columns, and nothing else may change.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, delete, truncate on table class_teacher_assignments, teaching_assignments
          from erp_app;
        grant update (ended_at, ended_by) on table class_teacher_assignments, teaching_assignments
          to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): timetables and attendance refer to these assignments.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the assignments in production: later tables refer to them');
  }
  await sql`drop table if exists teaching_assignments`.execute(db);
  await sql`drop table if exists class_teacher_assignments`.execute(db);
}
