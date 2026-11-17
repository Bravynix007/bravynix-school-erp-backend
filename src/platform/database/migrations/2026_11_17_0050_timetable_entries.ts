import { sql, type Kysely } from 'kysely';

/**
 * The class timetable (DDD 9.4, PRD 7.8): `timetable_entries`, one row for a section, a day of the week and a period.
 *
 * - An entry is a lesson (a subject and the teacher) or a break; `ck_timetable_entries_break` makes the subject and the
 *   teacher both set exactly when it is not a break. The period is one of the same year (`fk_..._slot` to
 *   `uq_time_slots_id_year`), the section one of the same Institution, the subject one of the same Society, and the
 *   teacher one whose home Institution this is (`uq_staff_members_id_home`), as for assignments: extra Institutions
 *   are view-only, so a teacher is never booked at one. That also means a teacher's clashes are always inside one
 *   Institution.
 * - A section has one entry in a day and period, and a teacher is in one place in a day and period, among the active
 *   rows (`uq_timetable_section_slot`, `uq_timetable_teacher_slot`), so two admins saving at once cannot both win.
 *   The day is 1 (Monday) to 7 (Sunday) as the DDD says; the service offers Monday to Saturday (decision 5).
 * - Institution-level row-level security (DDD 15.3). A parent reads the entries of the section their child sits in now
 *   (`timetable_entries_select_child`, through `student_section_placements` under its own child policy, which reads
 *   nothing of this table). Soft delete only, so the app role has no DELETE right.
 * - For that parent's view of a week: `subjects_select_child` shows the subjects of the child's Society, and
 *   `app_staff_names` (a definer function) answers the names, and only the names, of the teachers of the child's
 *   Institution, because a policy on `staff_members` would expose the whole record.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table timetable_entries (
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
      day_of_week smallint not null,
      time_slot_id uuid not null,
      is_break boolean not null default false,
      subject_id uuid,
      staff_member_id uuid,
      constraint fk_timetable_entries_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_timetable_entries_year foreign key (academic_year_id, institution_id)
        references academic_years (id, institution_id) on delete restrict,
      constraint fk_timetable_entries_section foreign key (section_id, institution_id)
        references sections (id, institution_id) on delete restrict,
      constraint fk_timetable_entries_slot foreign key (time_slot_id, academic_year_id)
        references time_slots (id, academic_year_id) on delete restrict,
      constraint fk_timetable_entries_subject foreign key (subject_id, society_id)
        references subjects (id, society_id) on delete restrict,
      constraint fk_timetable_entries_staff foreign key (staff_member_id, institution_id)
        references staff_members (id, home_institution_id) on delete restrict,
      constraint ck_timetable_entries_status check (status in (0, 1)),
      constraint ck_timetable_entries_day check (day_of_week between 1 and 7),
      constraint ck_timetable_entries_break
        check (is_break = (subject_id is null and staff_member_id is null))
    )
  `.execute(db);
  await sql`
    create unique index uq_timetable_section_slot
      on timetable_entries (section_id, day_of_week, time_slot_id) where status = 1
  `.execute(db);
  await sql`
    create unique index uq_timetable_teacher_slot
      on timetable_entries (staff_member_id, day_of_week, time_slot_id)
      where status = 1 and staff_member_id is not null
  `.execute(db);
  await sql`
    create index ix_timetable_entries_slot on timetable_entries (time_slot_id) where status = 1
  `.execute(db);
  await sql`
    create trigger trg_timetable_entries_updated before update on timetable_entries
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_timetable_entries_version before update on timetable_entries
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table timetable_entries enable row level security`.execute(db);
  await sql`alter table timetable_entries force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy timetable_entries_select on timetable_entries for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy timetable_entries_insert on timetable_entries for insert with check (${inScope})`.execute(
    db,
  );
  await sql`
    create policy timetable_entries_update on timetable_entries for update
      using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    create policy timetable_entries_select_child on timetable_entries for select using (
      app_current_role_code() = 5
      and status = 1
      and exists (
        select 1
        from student_section_placements p
        join student_enrolments e on e.id = p.student_enrolment_id
        where e.student_id = any (app_current_child_ids())
          and e.status = 1
          and p.end_date is null
          and p.section_id = timetable_entries.section_id
      )
    )
  `.execute(db);
  await sql`
    create policy subjects_select_child on subjects for select using (
      app_current_role_code() = 5
      and exists (
        select 1 from students s
        where s.id = any (app_current_child_ids()) and s.society_id = subjects.society_id
      )
    )
  `.execute(db);

  await sql`
    create function app_staff_names(p_ids uuid[])
      returns table (id uuid, first_name text, last_name text)
      language sql
      stable
      security definer
      set search_path = pg_catalog, public, pg_temp
    as $$
      select m.id, m.first_name::text, m.last_name::text
      from staff_members m
      where app_current_role_code() = 5
        and m.id = any (p_ids)
        and m.status = 1
        and exists (
          select 1 from students s
          where s.id = any (app_current_child_ids()) and s.institution_id = m.home_institution_id
        )
    $$
  `.execute(db);
  await sql`revoke all on function app_staff_names(uuid[]) from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function app_staff_names(uuid[]) to erp_app;
        revoke delete, truncate on table timetable_entries from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the school's timetable lives here.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop timetable_entries in production: it holds the class timetables',
    );
  }
  await sql`drop function if exists app_staff_names(uuid[])`.execute(db);
  await sql`drop policy if exists subjects_select_child on subjects`.execute(db);
  await sql`drop table if exists timetable_entries`.execute(db);
}
