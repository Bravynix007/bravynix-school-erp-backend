import { sql, type Kysely } from 'kysely';
import { clearScope, scopeTo, seededYearId } from './academic-seed.js';
import { seededStudents } from './people-seed.js';

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** A school day inside the seeded year (Tuesday 16 June 2026), as for the seeded attendance. */
const SEEDED_DIARY_DATE = '2026-06-16';

/**
 * One diary entry (Mathematics) for every seeded section that has students, written by no one in particular (an admin
 * with no staff record). Every world has an entry, so a test can show one Society's diary is hidden from another. Safe
 * to run twice.
 */
export async function writeDiarySeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  const sections = new Map<string, (typeof seededStudents)[number]>();
  for (const student of seededStudents) {
    if (!sections.has(student.sectionId)) sections.set(student.sectionId, student);
  }
  for (const [place, [sectionId, first]] of [...sections].entries()) {
    const societyId = await scopeTo(tx, first.home.id, `diary of ${first.home.key}`);
    await sql`
      insert into diary_entries (id, society_id, institution_id, academic_year_id, section_id, subject_id,
        diary_date, description)
      select ${seedId(8601 + place)}, ${societyId}, ${first.home.id}, ${seededYearId(first.home.key)},
        ${sectionId}, id, ${SEEDED_DIARY_DATE}, 'Practise the exercises of the chapter.'
      from subjects where society_id = ${societyId} and code = 'MATH'
      on conflict (id) do nothing
    `.execute(tx);
  }
  await clearScope(tx);
}
