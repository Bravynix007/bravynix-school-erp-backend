import { sql, type Kysely } from 'kysely';
import { clearScope, scopeTo, seededYearId } from './academic-seed.js';
import { seededStudents } from './people-seed.js';
import { personaByKey } from './two-worlds.js';

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** A school day inside the seeded year (Tuesday 16 June 2026), after every seeded child was placed. */
export const SEEDED_ATTENDANCE_DATE = '2026-06-16';

/**
 * One day's attendance for every seeded section that has students: the first child on the roll is Absent and the rest
 * Present, submitted by the Society Owner. Every world has a session and a mark, so a test can show one Society's
 * attendance is hidden from another. Safe to run twice.
 */
export async function writeAttendanceSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  const sections = new Map<string, typeof seededStudents>();
  for (const student of seededStudents) {
    sections.set(student.sectionId, [...(sections.get(student.sectionId) ?? []), student]);
  }
  for (const [place, [sectionId, placed]] of [...sections].entries()) {
    const first = placed[0]!;
    const societyId = await scopeTo(tx, first.home.id, `attendance of ${first.home.key}`);
    const sessionId = seedId(8101 + place);
    await sql`
      insert into attendance_sessions (id, society_id, institution_id, academic_year_id, section_id,
        attendance_date, roster_count, absent_count, submitted_by)
      values (${sessionId}, ${societyId}, ${first.home.id}, ${seededYearId(first.home.key)}, ${sectionId},
        ${SEEDED_ATTENDANCE_DATE}, ${placed.length}, 1,
        ${personaByKey(`SO-${first.home.society}1`).id})
      on conflict (id) do nothing
    `.execute(tx);
    await sql`
      insert into attendance_exceptions (attendance_session_id, student_enrolment_id, attendance_date,
        institution_id, attendance_status)
      values (${sessionId}, ${seedId(4101 + first.index)}, ${SEEDED_ATTENDANCE_DATE}, ${first.home.id}, 2)
      on conflict do nothing
    `.execute(tx);
  }
  await clearScope(tx);
}
