import { sql, type Kysely } from 'kysely';

/**
 * Attendance, part 3 (API design 10.13): a parent reads the attendance of their own child (role 5).
 *
 * Two read policies, both reading the children one request carries (`app_current_child_ids()`, migration 0043):
 * - `attendance_exceptions`: the marks of the child's own enrolments, which is the child's absences, lates, half days
 *   and leaves and nothing of any classmate;
 * - `attendance_sessions`: the sessions of the sections the child sits or sat in, which a calendar needs to say which
 *   days were marked at all. A session shows its counts and who submitted it, and no student.
 *
 * The enrolments and the placements are read through their own child policies, so a policy never reads the table it
 * guards. Nothing is written: the tables have no INSERT, UPDATE or DELETE policy for role 5.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create policy attendance_exceptions_select_child on attendance_exceptions for select
      using (
        student_enrolment_id in (
          select e.id from student_enrolments e where e.student_id = any (app_current_child_ids())
        )
      )
  `.execute(db);
  await sql`
    create policy attendance_sessions_select_child on attendance_sessions for select
      using (
        section_id in (
          select p.section_id
          from student_section_placements p
          join student_enrolments e on e.id = p.student_enrolment_id
          where e.student_id = any (app_current_child_ids())
        )
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the attendance parent read in production');
  }
  await sql`drop policy if exists attendance_sessions_select_child on attendance_sessions`.execute(
    db,
  );
  await sql`drop policy if exists attendance_exceptions_select_child on attendance_exceptions`.execute(
    db,
  );
}
