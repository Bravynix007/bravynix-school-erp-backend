import { sql, type Kysely } from 'kysely';

/**
 * Exam papers and the datesheet (DDD 9.7, PRD 7.11 step 2): `exam_papers`, one row for a section and a subject of an
 * exam, with the day and time it is sat, the room, the marks scale and the people. The exam gains the stamp of the
 * moment its datesheet was published.
 *
 * - A paper names an exam of its own year (`fk_exam_papers_exam` to `uq_exams_id_inst_year`), a section of the same
 *   Institution, a subject of the same Society, and a teacher and an invigilator whose home Institution this is
 *   (extra Institutions are view-only, so staff are never booked at one), as for timetable entries. The end is after
 *   the start, the marks scale is 1 to 1,000 and the passing marks are 0 up to the maximum.
 * - An exam has one active paper for a section and a subject (`uq_exam_papers_exam_section_subject`).
 * - No clash, among the active papers, whoever saves first. The DDD's start-time equality indexes would miss papers
 *   that overlap without starting together, so these are gist exclusions on the span of the day (as for periods and
 *   grade bands, from `btree_gist`): a section has no two papers that overlap (`ex_exam_papers_section_time`), nor
 *   does an invigilator (`ex_exam_papers_invigilator_time`), nor a room of an Institution, in any letter case
 *   (`ex_exam_papers_room_time`).
 * - `ix_exam_papers_subject_teacher` answers a teacher's papers to mark. Both people are optional.
 * - Institution-level row-level security (DDD 15.3). A parent reads the papers of the section their child sits in now,
 *   and only once the exam's datesheet is published (`exam_papers_select_child`, through `student_section_placements`
 *   under its own child policy, and `exams` under its own, which reads nothing of this table). Soft delete only, so the
 *   app role has no DELETE right.
 * - `datesheet_published_at` and `datesheet_published_by` on `exams` are both set or both empty; the publish endpoint
 *   (Phase 6 B3b) writes them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table exams
      add column datesheet_published_at timestamptz,
      add column datesheet_published_by uuid references users (id),
      add constraint ck_exams_datesheet_published
        check ((datesheet_published_at is null) = (datesheet_published_by is null))
  `.execute(db);

  await sql`
    create table exam_papers (
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
      exam_id uuid not null,
      section_id uuid not null,
      subject_id uuid not null,
      exam_date date not null,
      start_time time not null,
      end_time time not null,
      room_name varchar(50),
      max_marks integer not null default 100,
      passing_marks integer not null default 35,
      subject_teacher_staff_member_id uuid,
      invigilator_staff_member_id uuid,
      constraint fk_exam_papers_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_exam_papers_exam foreign key (exam_id, institution_id, academic_year_id)
        references exams (id, institution_id, academic_year_id) on delete restrict,
      constraint fk_exam_papers_section foreign key (section_id, institution_id)
        references sections (id, institution_id) on delete restrict,
      constraint fk_exam_papers_subject foreign key (subject_id, society_id)
        references subjects (id, society_id) on delete restrict,
      constraint fk_exam_papers_teacher foreign key (subject_teacher_staff_member_id, institution_id)
        references staff_members (id, home_institution_id) on delete restrict,
      constraint fk_exam_papers_invigilator foreign key (invigilator_staff_member_id, institution_id)
        references staff_members (id, home_institution_id) on delete restrict,
      constraint uq_exam_papers_id_institution unique (id, institution_id),
      constraint ck_exam_papers_status check (status in (0, 1)),
      constraint ck_exam_papers_times check (end_time > start_time),
      constraint ck_exam_papers_room check (room_name is null or btrim(room_name) <> ''),
      constraint ck_exam_papers_max_marks check (max_marks between 1 and 1000),
      constraint ck_exam_papers_passing_marks check (passing_marks between 0 and max_marks),
      constraint ex_exam_papers_section_time exclude using gist (
        section_id with =,
        tsrange(exam_date + start_time, exam_date + end_time) with &&
      ) where (status = 1),
      constraint ex_exam_papers_invigilator_time exclude using gist (
        invigilator_staff_member_id with =,
        tsrange(exam_date + start_time, exam_date + end_time) with &&
      ) where (status = 1 and invigilator_staff_member_id is not null),
      constraint ex_exam_papers_room_time exclude using gist (
        institution_id with =,
        (lower(room_name)) with =,
        tsrange(exam_date + start_time, exam_date + end_time) with &&
      ) where (status = 1 and room_name is not null)
    )
  `.execute(db);
  await sql`
    create unique index uq_exam_papers_exam_section_subject
      on exam_papers (exam_id, section_id, subject_id) where status = 1
  `.execute(db);
  await sql`
    create index ix_exam_papers_subject_teacher
      on exam_papers (subject_teacher_staff_member_id, academic_year_id)
      where status = 1 and subject_teacher_staff_member_id is not null
  `.execute(db);
  await sql`
    create index ix_exam_papers_exam on exam_papers (exam_id) where status = 1
  `.execute(db);
  await sql`
    create trigger trg_exam_papers_updated before update on exam_papers
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_exam_papers_version before update on exam_papers
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table exam_papers enable row level security`.execute(db);
  await sql`alter table exam_papers force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy exam_papers_select on exam_papers for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy exam_papers_insert on exam_papers for insert with check (${inScope})`.execute(
    db,
  );
  await sql`
    create policy exam_papers_update on exam_papers for update
      using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    create policy exam_papers_select_child on exam_papers for select using (
      app_current_role_code() = 5
      and status = 1
      and exists (
        select 1 from exams x
        where x.id = exam_papers.exam_id
          and x.status = 1
          and x.datesheet_published_at is not null
      )
      and exists (
        select 1
        from student_section_placements p
        join student_enrolments e on e.id = p.student_enrolment_id
        where e.student_id = any (app_current_child_ids())
          and e.status = 1
          and p.end_date is null
          and p.section_id = exam_papers.section_id
      )
    )
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table exam_papers from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the school's datesheets live here.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop exam_papers in production: it holds the schools’ datesheets');
  }
  await sql`drop table if exists exam_papers`.execute(db);
  await sql`
    alter table exams
      drop constraint if exists ck_exams_datesheet_published,
      drop column if exists datesheet_published_by,
      drop column if exists datesheet_published_at
  `.execute(db);
}
