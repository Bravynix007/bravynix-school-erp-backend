import { sql, type Kysely } from 'kysely';
import { institutions } from './two-worlds.js';

const yearId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

export interface SeedAcademicYear {
  id: string;
  institutionId: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

/** The seeded current year of a two-worlds Institution, so a test can find its row. */
export const seededYearId = (institutionKey: string): string => {
  const index = institutions.findIndex((i) => i.key === institutionKey);
  if (index < 0) throw new Error(`Unknown two-worlds Institution ${institutionKey}`);
  return yearId(3101 + index);
};

export const seededYearName = '2026-2027';

/** Every two-worlds Institution has one current year, so classes and the rest can be added to it at once. */
export const academicYears: SeedAcademicYear[] = institutions.map((institution) => ({
  id: seededYearId(institution.key),
  institutionId: institution.id,
  name: seededYearName,
  startDate: '2026-06-01',
  endDate: '2027-03-31',
  isCurrent: true,
}));

/**
 * Writes academic years. The table is scoped to its Institution, even for the table owner, so each year is written
 * with that Institution's scope set for the transaction. Safe to run twice: rows are keyed by their fixed IDs.
 */
export async function insertAcademicYears(
  db: Kysely<unknown>,
  years: readonly SeedAcademicYear[],
): Promise<void> {
  for (const year of years) {
    // Institutions are read as Super Admin to learn the Society; the year is then written in that scope.
    await sql`select set_config('app.role_code', '1', true)`.execute(db);
    const { rows } = await sql<{ society_id: string }>`
      select society_id from institutions where id = ${year.institutionId}
    `.execute(db);
    const societyId = rows[0]?.society_id;
    if (!societyId) throw new Error(`Seeded academic year ${year.id} names an unknown Institution`);
    await sql`
      select set_config('app.society_id', ${societyId}, true),
        set_config('app.institution_ids', ${year.institutionId}, true)
    `.execute(db);
    await sql`
      insert into academic_years (id, society_id, institution_id, name, start_date, end_date, is_current)
      values (${year.id}, ${societyId}, ${year.institutionId}, ${year.name}, ${year.startDate},
        ${year.endDate}, ${year.isCurrent})
      on conflict (id) do nothing
    `.execute(db);
  }
  await sql`
    select set_config('app.society_id', '', true), set_config('app.institution_ids', '', true)
  `.execute(db);
}

/** The two-worlds scenario's years; runs after the identity seed, which writes the Institutions. */
export async function writeAcademicSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return insertAcademicYears(db, academicYears);
  await db.transaction().execute((tx) => insertAcademicYears(tx, academicYears));
}
