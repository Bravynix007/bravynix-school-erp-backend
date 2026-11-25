import { sql, type Kysely } from 'kysely';

/**
 * Scratch Societies for tests that need a real one to point a grant at. The
 * tenant roots force row-level security even on their owner and have no DELETE
 * policy, so writing is done as Super Admin and removing needs the force lifted
 * for the length of one transaction. Institutions, blocks, rates, dues and the sessions acting in it go with their Society.
 */
export async function createScratchSociety(db: Kysely<unknown>, id: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await sql`select set_config('app.role_code', '1', true)`.execute(tx);
    await sql`insert into societies (id, name, code) values (${id}, 'Scratch', ${id})`.execute(tx);
  });
}

export async function removeScratchSocieties(
  db: Kysely<unknown>,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction().execute(async (tx) => {
    await sql`alter table societies no force row level security`.execute(tx);
    await sql`alter table institutions no force row level security`.execute(tx);
    await sql`alter table access_blocks no force row level security`.execute(tx);
    await sql`alter table institution_price_rates no force row level security`.execute(tx);
    await sql`alter table platform_dues no force row level security`.execute(tx);
    await sql`alter table academic_years no force row level security`.execute(tx);
    await sql`alter table subjects no force row level security`.execute(tx);
    await sql`alter table classes no force row level security`.execute(tx);
    await sql`alter table sections no force row level security`.execute(tx);
    await sql`alter table institution_class_categories no force row level security`.execute(tx);
    await sql`alter table files no force row level security`.execute(tx);
    await sql`alter table import_runs no force row level security`.execute(tx);
    await sql`alter table staff_members no force row level security`.execute(tx);
    await sql`alter table staff_educations no force row level security`.execute(tx);
    await sql`alter table staff_emergency_contacts no force row level security`.execute(tx);
    await sql`alter table staff_institutions no force row level security`.execute(tx);
    await sql`alter table staff_subjects no force row level security`.execute(tx);
    await sql`alter table staff_identities no force row level security`.execute(tx);
    await sql`alter table documents no force row level security`.execute(tx);
    await sql`alter table inbox_items no force row level security`.execute(tx);
    await sql`alter table attendance_sessions no force row level security`.execute(tx);
    await sql`alter table attendance_exceptions no force row level security`.execute(tx);
    await sql`alter table events no force row level security`.execute(tx);
    await sql`alter table time_slots no force row level security`.execute(tx);
    await sql`alter table timetable_entries no force row level security`.execute(tx);
    await sql`alter table diary_entries no force row level security`.execute(tx);
    await sql`alter table grade_bands no force row level security`.execute(tx);
    await sql`alter table exams no force row level security`.execute(tx);
    await sql`alter table event_holiday_classes no force row level security`.execute(tx);
    await sql`alter table students no force row level security`.execute(tx);
    await sql`alter table student_guardians no force row level security`.execute(tx);
    await sql`alter table student_identities no force row level security`.execute(tx);
    await sql`alter table student_enrolments no force row level security`.execute(tx);
    await sql`alter table student_achievements no force row level security`.execute(tx);
    await sql`alter table student_section_placements no force row level security`.execute(tx);
    await sql`alter table teaching_assignments no force row level security`.execute(tx);
    await sql`alter table class_teacher_assignments no force row level security`.execute(tx);
    await sql`
      delete from refresh_tokens where session_id in
        (select id from auth_sessions where active_society_id in (${sql.join(ids)}))`.execute(tx);
    await sql`delete from auth_sessions where active_society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from role_assignments where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from access_blocks where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from platform_dues where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from institution_price_rates where society_id in (${sql.join(ids)})`.execute(
      tx,
    );
    await sql`delete from import_runs where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from jobs where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`
      delete from attendance_exceptions where institution_id in
        (select id from institutions where society_id in (${sql.join(ids)}))`.execute(tx);
    await sql`delete from attendance_sessions where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from inbox_items where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from event_holiday_classes where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from events where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from documents where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from student_achievements where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from student_section_placements where society_id in (${sql.join(ids)})`.execute(
      tx,
    );
    await sql`delete from student_enrolments where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from student_identities where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from student_guardians where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from students where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from staff_identities where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from teaching_assignments where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from class_teacher_assignments where society_id in (${sql.join(ids)})`.execute(
      tx,
    );
    await sql`delete from staff_subjects where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from staff_institutions where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from diary_entries where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from grade_bands where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from exams where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from timetable_entries where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from time_slots where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from academic_years where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from subjects where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from sections where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from classes where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from staff_emergency_contacts where society_id in (${sql.join(ids)})`.execute(
      tx,
    );
    await sql`delete from staff_educations where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from staff_members where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from files where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from institution_class_categories where society_id in (${sql.join(ids)})`.execute(
      tx,
    );
    await sql`delete from institutions where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from societies where id in (${sql.join(ids)})`.execute(tx);
    await sql`alter table files force row level security`.execute(tx);
    await sql`alter table import_runs force row level security`.execute(tx);
    await sql`alter table staff_members force row level security`.execute(tx);
    await sql`alter table staff_educations force row level security`.execute(tx);
    await sql`alter table staff_emergency_contacts force row level security`.execute(tx);
    await sql`alter table staff_institutions force row level security`.execute(tx);
    await sql`alter table staff_subjects force row level security`.execute(tx);
    await sql`alter table staff_identities force row level security`.execute(tx);
    await sql`alter table documents force row level security`.execute(tx);
    await sql`alter table inbox_items force row level security`.execute(tx);
    await sql`alter table attendance_sessions force row level security`.execute(tx);
    await sql`alter table attendance_exceptions force row level security`.execute(tx);
    await sql`alter table events force row level security`.execute(tx);
    await sql`alter table time_slots force row level security`.execute(tx);
    await sql`alter table timetable_entries force row level security`.execute(tx);
    await sql`alter table diary_entries force row level security`.execute(tx);
    await sql`alter table grade_bands force row level security`.execute(tx);
    await sql`alter table exams force row level security`.execute(tx);
    await sql`alter table event_holiday_classes force row level security`.execute(tx);
    await sql`alter table students force row level security`.execute(tx);
    await sql`alter table student_guardians force row level security`.execute(tx);
    await sql`alter table student_identities force row level security`.execute(tx);
    await sql`alter table student_enrolments force row level security`.execute(tx);
    await sql`alter table student_achievements force row level security`.execute(tx);
    await sql`alter table student_section_placements force row level security`.execute(tx);
    await sql`alter table teaching_assignments force row level security`.execute(tx);
    await sql`alter table class_teacher_assignments force row level security`.execute(tx);
    await sql`alter table access_blocks force row level security`.execute(tx);
    await sql`alter table academic_years force row level security`.execute(tx);
    await sql`alter table subjects force row level security`.execute(tx);
    await sql`alter table classes force row level security`.execute(tx);
    await sql`alter table sections force row level security`.execute(tx);
    await sql`alter table institution_class_categories force row level security`.execute(tx);
    await sql`alter table platform_dues force row level security`.execute(tx);
    await sql`alter table institution_price_rates force row level security`.execute(tx);
    await sql`alter table institutions force row level security`.execute(tx);
    await sql`alter table societies force row level security`.execute(tx);
  });
}
