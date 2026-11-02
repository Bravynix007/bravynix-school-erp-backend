import { sql, type Kysely } from 'kysely';
import { institutions, societies } from './two-worlds.js';

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

export interface SeedSubject {
  id: string;
  societyId: string;
  name: string;
  code: string;
}

/** The subjects every Society starts a demo or test with. Each Society's rows take their own IDs. */
export const commonSubjects: readonly { name: string; code: string }[] = [
  { name: 'English', code: 'ENG' },
  { name: 'Mathematics', code: 'MATH' },
  { name: 'Science', code: 'SCI' },
  { name: 'Social Science', code: 'SOC' },
];

/** The two-worlds Societies' subjects: the same four in each, so a test can show one Society cannot see the other's. */
export const subjects: SeedSubject[] = societies.flatMap((society, s) =>
  commonSubjects.map((subject, n) => ({
    id: yearId(3201 + s * 10 + n),
    societyId: society.id,
    ...subject,
  })),
);

/** Writes subjects, each in its Society's scope. Safe to run twice: rows are keyed by their fixed IDs. */
export async function insertSubjects(
  db: Kysely<unknown>,
  rows: readonly SeedSubject[],
): Promise<void> {
  for (const subject of rows) {
    await sql`select set_config('app.society_id', ${subject.societyId}, true)`.execute(db);
    await sql`
      insert into subjects (id, society_id, name, code)
      values (${subject.id}, ${subject.societyId}, ${subject.name}, ${subject.code})
      on conflict (id) do nothing
    `.execute(db);
  }
  await sql`select set_config('app.society_id', '', true)`.execute(db);
}

/**
 * Sets the scope an Institution's rows are written in. These tables are scoped to the Institution even for the
 * table owner, so each row is written with that Institution's Society and ID set for the transaction. The
 * Society is read as Super Admin. Returns the Society.
 */
async function scopeTo(db: Kysely<unknown>, institutionId: string, what: string): Promise<string> {
  await sql`select set_config('app.role_code', '1', true)`.execute(db);
  const { rows } = await sql<{ society_id: string }>`
    select society_id from institutions where id = ${institutionId}
  `.execute(db);
  const societyId = rows[0]?.society_id;
  if (!societyId) throw new Error(`Seeded ${what} names an unknown Institution`);
  await sql`
    select set_config('app.society_id', ${societyId}, true),
      set_config('app.institution_ids', ${institutionId}, true)
  `.execute(db);
  return societyId;
}

async function clearScope(db: Kysely<unknown>): Promise<void> {
  await sql`
    select set_config('app.society_id', '', true), set_config('app.institution_ids', '', true)
  `.execute(db);
}

/** Writes academic years. Safe to run twice: rows are keyed by their fixed IDs. */
export async function insertAcademicYears(
  db: Kysely<unknown>,
  years: readonly SeedAcademicYear[],
): Promise<void> {
  for (const year of years) {
    const societyId = await scopeTo(db, year.institutionId, `academic year ${year.id}`);
    await sql`
      insert into academic_years (id, society_id, institution_id, name, start_date, end_date, is_current)
      values (${year.id}, ${societyId}, ${year.institutionId}, ${year.name}, ${year.startDate},
        ${year.endDate}, ${year.isCurrent})
      on conflict (id) do nothing
    `.execute(db);
  }
  await clearScope(db);
}

/** The class categories an Institution offers, by their codes in the platform masters (decision 24). */
export interface SeedClassesOffered {
  institutionId: string;
  categories: readonly string[];
}

/** Two-worlds: A1 a school, A2 a pre-school, B1 a school with a Pre-University college, so every case has an Institution. */
export const classesOffered: SeedClassesOffered[] = [
  {
    institutionId: institutions[0]!.id,
    categories: ['LOWER_PRIMARY', 'HIGHER_PRIMARY', 'HIGH_SCHOOL'],
  },
  { institutionId: institutions[1]!.id, categories: ['PRE_SCHOOL', 'NURSERY', 'LOWER_PRIMARY'] },
  {
    institutionId: institutions[2]!.id,
    categories: ['LOWER_PRIMARY', 'HIGHER_PRIMARY', 'HIGH_SCHOOL', 'PRE_UNIVERSITY'],
  },
];

/**
 * Writes what each Institution offers, so classes can be added to it at once. The categories are seeded by the
 * migration. Safe to run twice: a category already offered is left as it is.
 */
export async function insertClassesOffered(
  db: Kysely<unknown>,
  offers: readonly SeedClassesOffered[],
): Promise<void> {
  for (const { institutionId, categories } of offers) {
    const societyId = await scopeTo(db, institutionId, 'classes offered');
    await sql`
      insert into institution_class_categories (society_id, institution_id, class_category_id)
      select ${societyId}, ${institutionId}, id from class_categories
      where code in (${sql.join(categories.map((code) => sql.val(code)))})
      on conflict do nothing
    `.execute(db);
  }
  await clearScope(db);
}

/** A section of a seeded class, by the code of its predefined section (`A`). */
export interface SeedSection {
  id: string;
  predefinedCode: string;
  capacity: number | null;
}

/** A class of an Institution, by the code of its predefined class (`C09`); its category must be one the Institution offers. */
export interface SeedClass {
  id: string;
  institutionId: string;
  predefinedCode: string;
  streamName: string | null;
  sections: readonly SeedSection[];
}

/** The seeded class `n` of the two-worlds list, so a test can find its row. */
export const seededClassId = (n: number): string => yearId(3301 + n);

/** Two-worlds: A1 a first and a ninth class, A2 a Nursery, B1 a Pre-University class with its stream, so every case has one. */
const twoWorldsClasses: readonly {
  institution: number;
  predefinedCode: string;
  streamName: string | null;
  sections: readonly string[];
}[] = [
  { institution: 0, predefinedCode: 'C01', streamName: null, sections: ['A', 'B'] },
  { institution: 0, predefinedCode: 'C09', streamName: null, sections: ['A'] },
  { institution: 1, predefinedCode: 'NUR', streamName: null, sections: ['A'] },
  { institution: 2, predefinedCode: 'PUC1', streamName: 'PCMC', sections: ['A'] },
];

export const classes: SeedClass[] = twoWorldsClasses.map((entry, n) => ({
  id: seededClassId(n),
  institutionId: institutions[entry.institution]!.id,
  predefinedCode: entry.predefinedCode,
  streamName: entry.streamName,
  sections: entry.sections.map((code, k) => ({
    id: yearId(3500 + n * 10 + k),
    predefinedCode: code,
    capacity: 40,
  })),
}));

/**
 * Writes classes and their sections, each in its Institution's scope; the class takes the name of the predefined
 * class (and the stream after it). Safe to run twice: rows are keyed by their fixed IDs.
 */
export async function insertClasses(
  db: Kysely<unknown>,
  rows: readonly SeedClass[],
): Promise<void> {
  for (const row of rows) {
    const societyId = await scopeTo(db, row.institutionId, `class ${row.id}`);
    await sql`
      insert into classes (id, society_id, institution_id, predefined_class_id, class_category_id,
        stream_name, display_name)
      select ${row.id}, ${societyId}, ${row.institutionId}, p.id, p.class_category_id, ${row.streamName},
        case when ${row.streamName}::text is null then p.name else p.name || ' ' || ${row.streamName}::text end
      from predefined_classes p where p.code = ${row.predefinedCode}
      on conflict (id) do nothing
    `.execute(db);
    for (const section of row.sections) {
      await sql`
        insert into sections (id, society_id, institution_id, class_id, predefined_section_id,
          display_name, capacity)
        select ${section.id}, ${societyId}, ${row.institutionId}, ${row.id}, p.id, p.name, ${section.capacity}
        from predefined_sections p where p.code = ${section.predefinedCode}
        on conflict (id) do nothing
      `.execute(db);
    }
  }
  await clearScope(db);
}

/** The two-worlds scenario's years, subjects and classes offered; runs after the identity seed, which writes the Institutions. */
export async function writeAcademicSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  await insertAcademicYears(tx, academicYears);
  await insertSubjects(tx, subjects);
  await insertClassesOffered(tx, classesOffered);
  await insertClasses(tx, classes);
}
