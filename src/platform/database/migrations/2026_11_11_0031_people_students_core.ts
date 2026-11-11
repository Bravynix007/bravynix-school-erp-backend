import { sql, type Kysely } from 'kysely';

/** The key every student table has to its Institution, named for the table. */
const keyed = (table: string) => sql`
    constraint ${sql.id(`fk_${table}_institution`)} foreign key (institution_id, society_id)
      references institutions (id, society_id) on delete restrict
`;

/**
 * People, part 6 (DDD 9.6, PRD 7.6): the student record, its guardians, its class for a year and the section it sits in.
 *
 * - `students`: a child at one Institution, deactivated (`status` 0), never deleted. The Admission ID is unique per
 *   Institution among active records, ignoring letter case, and is free again once the record is deactivated.
 *   `search_text` (name and Admission ID, lower case) is a stored column behind a trigram index, so the list's search
 *   runs on the index (SDD 10.5). The block and deactivation columns arrive with the slices that use them.
 * - `student_guardians`: a parent or guardian, linked to a person account when an email is given; that link is the
 *   Student / Parent login. One email can be linked to several children, so the person is a column here and never
 *   unique to a child's record. At most one primary guardian a student, and a person only once for a student.
 * - `student_enrolments`: the child's class for one academic year, one active row a year. The year and the class are
 *   checked by composite keys to the same Institution.
 * - `student_section_placements`: which section and roll number from which day to which day. One section at a time
 *   (a gist exclusion on the dates), a roll number once among the current students of a section, and a section that
 *   belongs to the enrolment's class (composite keys). A move closes the row and opens another.
 *
 * All four use the Institution-level policy (DDD 15.3). A person also reads the guardian rows that are theirs,
 * whichever Institution they are at ("own records", as staff do in migration 0025):
 * the two block functions of migration 0011 look for them with the person's settings, before any tenant is set. Those
 * two functions now answer
 * for a person who is a guardian of an active student in the Society, as they do for staff and Admins, so a blocked
 * parent is stopped and told why.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const standard = sql`
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      society_id uuid not null,
      institution_id uuid not null
  `;

  await sql`
    create table students (
      ${standard},
      status smallint not null default 1,
      admission_no varchar(50),
      first_name varchar(100) not null,
      last_name varchar(100),
      gender smallint,
      date_of_birth date,
      blood_group varchar(3),
      nationality varchar(50),
      photo_file_id uuid,
      admission_date date,
      contact_email varchar(254),
      country_code varchar(4),
      mobile_number varchar(15),
      alternate_number varchar(15),
      address_line_1 varchar(255),
      address_line_2 varchar(255),
      country_id uuid references countries (id) on delete restrict,
      state_id uuid references states (id) on delete restrict,
      city_id uuid references cities (id) on delete restrict,
      pincode varchar(10),
      search_text text generated always as (
        lower(first_name || ' ' || coalesce(last_name, '') || ' ' || coalesce(admission_no, ''))
      ) stored,
      ${keyed('students')},
      constraint fk_students_photo foreign key (photo_file_id, society_id)
        references files (id, society_id) on delete restrict,
      constraint uq_students_id_institution unique (id, institution_id),
      constraint ck_students_status check (status in (0, 1)),
      constraint ck_students_first_name check (btrim(first_name) <> ''),
      constraint ck_students_admission_no check (admission_no is null or btrim(admission_no) <> ''),
      constraint ck_students_gender check (gender is null or gender in (1, 2, 3)),
      constraint ck_students_blood_group
        check (blood_group is null or blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
      constraint ck_students_contact_email check (contact_email is null or contact_email = lower(contact_email)),
      constraint ck_students_phone check (
        (country_code is null) = (mobile_number is null)
        and (country_code is null or (country_code ~ '^[0-9]{1,4}$' and mobile_number ~ '^[0-9]{6,15}$'))
      ),
      constraint ck_students_alternate check (alternate_number is null or alternate_number ~ '^[0-9]{6,15}$')
    )
  `.execute(db);
  await sql`
    create unique index uq_students_institution_admission_no
      on students (institution_id, lower(admission_no)) where admission_no is not null and status = 1
  `.execute(db);
  // A photo belongs to one child; a second record pointing at it is refused.
  await sql`
    create unique index uq_students_photo on students (photo_file_id) where photo_file_id is not null
  `.execute(db);
  await sql`
    create index ix_students_search_trgm on students using gin (search_text gin_trgm_ops) where status = 1
  `.execute(db);
  await sql`
    create index ix_students_institution on students (institution_id, created_at desc, id) where status = 1
  `.execute(db);

  await sql`
    create table student_guardians (
      ${standard},
      status smallint not null default 1,
      student_id uuid not null,
      user_id uuid references users (id) on delete restrict,
      first_name varchar(100) not null,
      last_name varchar(100),
      relation smallint not null,
      country_code varchar(4) not null,
      phone_number varchar(15) not null,
      alternate_phone varchar(15),
      email varchar(254),
      occupation varchar(100),
      is_primary boolean not null default false,
      is_emergency_contact boolean not null default false,
      ${keyed('student_guardians')},
      constraint fk_student_guardians_student foreign key (student_id, institution_id)
        references students (id, institution_id) on delete restrict,
      constraint ck_student_guardians_status check (status in (0, 1)),
      constraint ck_student_guardians_first_name check (btrim(first_name) <> ''),
      constraint ck_student_guardians_relation check (relation between 1 and 6),
      constraint ck_student_guardians_phone
        check (country_code ~ '^[0-9]{1,4}$' and phone_number ~ '^[0-9]{6,15}$'),
      constraint ck_student_guardians_alternate check (alternate_phone is null or alternate_phone ~ '^[0-9]{6,15}$'),
      constraint ck_student_guardians_email check (email is null or email = lower(email)),
      constraint ck_student_guardians_login check (email is not null or user_id is null)
    )
  `.execute(db);
  await sql`
    create unique index uq_student_guardians_primary
      on student_guardians (student_id) where is_primary and status = 1
  `.execute(db);
  await sql`
    create unique index uq_student_guardians_student_user
      on student_guardians (student_id, user_id) where user_id is not null and status = 1
  `.execute(db);
  await sql`
    create index ix_student_guardians_student on student_guardians (student_id) where status = 1
  `.execute(db);
  await sql`
    create index ix_student_guardians_user on student_guardians (user_id) where user_id is not null and status = 1
  `.execute(db);

  await sql`
    create table student_enrolments (
      ${standard},
      status smallint not null default 1,
      academic_year_id uuid not null,
      student_id uuid not null,
      class_id uuid not null,
      enrolled_date date not null,
      left_date date,
      outcome smallint,
      ${keyed('student_enrolments')},
      constraint fk_student_enrolments_year foreign key (academic_year_id, institution_id)
        references academic_years (id, institution_id) on delete restrict,
      constraint fk_student_enrolments_student foreign key (student_id, institution_id)
        references students (id, institution_id) on delete restrict,
      constraint fk_student_enrolments_class foreign key (class_id, institution_id)
        references classes (id, institution_id) on delete restrict,
      constraint uq_student_enrolments_id_institution unique (id, institution_id),
      constraint uq_student_enrolments_id_class unique (id, class_id),
      constraint uq_student_enrolments_id_year unique (id, academic_year_id),
      constraint ck_student_enrolments_status check (status in (0, 1)),
      constraint ck_student_enrolments_left check (left_date is null or left_date >= enrolled_date),
      constraint ck_student_enrolments_outcome check (outcome is null or outcome between 1 and 4)
    )
  `.execute(db);
  await sql`
    create unique index uq_student_enrolments_student_year
      on student_enrolments (student_id, academic_year_id) where status = 1
  `.execute(db);
  await sql`
    create index ix_student_enrolments_year_class on student_enrolments (academic_year_id, class_id) where status = 1
  `.execute(db);

  await sql`
    create table student_section_placements (
      ${standard},
      academic_year_id uuid not null,
      student_enrolment_id uuid not null,
      class_id uuid not null,
      section_id uuid not null,
      roll_number varchar(20) not null,
      start_date date not null,
      end_date date,
      ${keyed('student_section_placements')},
      constraint fk_placements_enrolment foreign key (student_enrolment_id, institution_id)
        references student_enrolments (id, institution_id) on delete restrict,
      constraint fk_placements_enrolment_class foreign key (student_enrolment_id, class_id)
        references student_enrolments (id, class_id) on delete restrict,
      constraint fk_placements_enrolment_year foreign key (student_enrolment_id, academic_year_id)
        references student_enrolments (id, academic_year_id) on delete restrict,
      constraint fk_placements_section foreign key (section_id, class_id)
        references sections (id, class_id) on delete restrict,
      constraint ck_placements_roll check (btrim(roll_number) <> ''),
      constraint ck_placements_dates check (end_date is null or end_date >= start_date),
      constraint ex_placements_no_overlap exclude using gist (
        student_enrolment_id with =,
        daterange(start_date, end_date, '[]') with &&
      )
    )
  `.execute(db);
  await sql`
    create unique index uq_placements_roll
      on student_section_placements (academic_year_id, section_id, lower(roll_number)) where end_date is null
  `.execute(db);
  await sql`
    create index ix_placements_section_dates
      on student_section_placements (section_id, start_date) include (end_date, student_enrolment_id)
  `.execute(db);
  await sql`
    create index ix_placements_enrolment on student_section_placements (student_enrolment_id)
  `.execute(db);

  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  for (const table of [
    'students',
    'student_guardians',
    'student_enrolments',
    'student_section_placements',
  ]) {
    const name = sql.table(table);
    const policy = (suffix: string) => sql.id(`${table}_${suffix}`);
    await sql`
      create trigger ${sql.id(`trg_${table}_updated`)} before update on ${name}
        for each row execute function set_updated_at()
    `.execute(db);
    await sql`
      create trigger ${sql.id(`trg_${table}_version`)} before update on ${name}
        for each row execute function bump_version()
    `.execute(db);
    await sql`alter table ${name} enable row level security`.execute(db);
    await sql`alter table ${name} force row level security`.execute(db);
    if (table !== 'student_guardians') {
      await sql`create policy ${policy('select')} on ${name} for select using (${inScope})`.execute(
        db,
      );
    }
    await sql`create policy ${policy('insert')} on ${name} for insert with check (${inScope})`.execute(
      db,
    );
    await sql`
      create policy ${policy('update')} on ${name} for update
        using (${inScope}) with check (${inScope})
    `.execute(db);
  }
  await sql`
    create policy student_guardians_select on student_guardians for select
      using (
        (society_id = app_current_society_id() and institution_id = any (app_current_institution_ids()))
        or user_id = app_current_person_id()
      )
  `.execute(db);
  // A record is deactivated, never deleted. A placement entered by mistake may be removed (DDD 9.6) once a slice
  // does so; until then the app role has no delete policy on it, so row-level security refuses one.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table students, student_guardians, student_enrolments from erp_app;
        revoke truncate on table student_section_placements from erp_app;
      end if;
    end;
    $$
  `.execute(db);

  await replaceBlockFunctions(db, true);

  // A Super Admin is never a guardian, in either direction (owner decision, 11 Nov 2026). Making a person Super Admin
  // asks whether they already guard a child anywhere; a Super Admin's tenant sees no Society's student rows, so the
  // one boolean comes from a definer function, as for staff (migration 0026). Dormant access counts: an ended or
  // deactivated child's row still stands until the guardian is removed.
  await sql`
    create function app_is_guardian(person uuid) returns boolean
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_person text := current_setting('app.person_id', true);
      found boolean;
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.person_id', person::text, true);
      select exists (
        select 1 from student_guardians g where g.user_id = person and g.status = 1
      ) into found;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.person_id', coalesce(caller_person, ''), true);
      return found;
    end;
    $$
  `.execute(db);
  await sql`revoke all on function app_is_guardian(uuid) from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function app_is_guardian(uuid) to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

/**
 * The two definer functions of migration 0011, as migration 0024 left them, answering now for a guardian of an active
 * student as well. A function acts as Super Admin for the one read, with the Society and its Institutions set (so the
 * staff, guardian and student rows of the Society are in scope), then puts the caller's settings back.
 * `withGuardian` false leaves the guardian out again.
 */
async function replaceBlockFunctions(db: Kysely<unknown>, withGuardian: boolean): Promise<void> {
  const holds = (society: string, person: string) =>
    sql.raw(`
        exists (
          select 1 from role_assignments g
          where g.user_id = ${person} and g.society_id = ${society} and g.revoked_at is null
        )
        or exists (
          select 1 from staff_members m
          where m.user_id = ${person} and m.society_id = ${society} and m.status = 1
        )${
          withGuardian
            ? `
        or exists (
          select 1 from student_guardians sg
          join students st on st.id = sg.student_id and st.status = 1
          where sg.user_id = ${person} and sg.society_id = ${society} and sg.status = 1
        )`
            : ''
        }`);
  await sql`
    create or replace function app_active_blocks(society uuid, person uuid)
      returns table (section smallint, institution_id uuid)
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_society text := current_setting('app.society_id', true);
      caller_institutions text := current_setting('app.institution_ids', true);
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.society_id', society::text, true);
      perform set_config(
        'app.institution_ids',
        coalesce((select string_agg(i.id::text, ',') from institutions i where i.society_id = society), ''),
        true
      );
      return query
        select b.section, b.institution_id from access_blocks b
        where b.society_id = society and b.lifted_at is null
          and (${holds('society', 'person')});
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.society_id', coalesce(caller_society, ''), true);
      perform set_config('app.institution_ids', coalesce(caller_institutions, ''), true);
    end;
    $$
  `.execute(db);
  await sql`
    create or replace function app_society_name(society uuid, person uuid) returns text
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_society text := current_setting('app.society_id', true);
      caller_institutions text := current_setting('app.institution_ids', true);
      found_name text;
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.society_id', society::text, true);
      perform set_config(
        'app.institution_ids',
        coalesce((select string_agg(i.id::text, ',') from institutions i where i.society_id = society), ''),
        true
      );
      select s.name into found_name from societies s
      where s.id = society
        and (${holds('society', 'person')});
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.society_id', coalesce(caller_society, ''), true);
      perform set_config('app.institution_ids', coalesce(caller_institutions, ''), true);
      return found_name;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): attendance, fees and exams refer to the student record.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop students in production: later tables refer to them');
  }
  await sql`drop function if exists app_is_guardian(uuid)`.execute(db);
  await replaceBlockFunctions(db, false);
  await sql`drop table if exists student_section_placements`.execute(db);
  await sql`drop table if exists student_enrolments`.execute(db);
  await sql`drop table if exists student_guardians`.execute(db);
  await sql`drop table if exists students`.execute(db);
}
