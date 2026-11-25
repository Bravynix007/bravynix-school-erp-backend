import { sql, type Kysely } from 'kysely';
import { classes, clearScope, scopeTo, seededYearId } from './academic-seed.js';
import { seededStaffId } from './people-seed.js';
import { institutions } from './two-worlds.js';

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

export interface SeedGradeBand {
  name: string;
  minPercentage: number;
  maxPercentage: number;
  gradePoint: number | null;
  description: string;
}

/**
 * The CBSE nine-point scale, highest first. Both ends belong to a band and percentages carry two decimals, so each band
 * ends one hundredth below the next one starts.
 */
export const gradeScale: readonly SeedGradeBand[] = [
  { name: 'A1', minPercentage: 91, maxPercentage: 100, gradePoint: 10, description: 'Outstanding' },
  { name: 'A2', minPercentage: 81, maxPercentage: 90.99, gradePoint: 9, description: 'Excellent' },
  { name: 'B1', minPercentage: 71, maxPercentage: 80.99, gradePoint: 8, description: 'Very good' },
  { name: 'B2', minPercentage: 61, maxPercentage: 70.99, gradePoint: 7, description: 'Good' },
  {
    name: 'C1',
    minPercentage: 51,
    maxPercentage: 60.99,
    gradePoint: 6,
    description: 'Above average',
  },
  { name: 'C2', minPercentage: 41, maxPercentage: 50.99, gradePoint: 5, description: 'Average' },
  { name: 'D', minPercentage: 33, maxPercentage: 40.99, gradePoint: 4, description: 'Pass' },
  {
    name: 'E1',
    minPercentage: 21,
    maxPercentage: 32.99,
    gradePoint: null,
    description: 'Needs improvement',
  },
  {
    name: 'E2',
    minPercentage: 0,
    maxPercentage: 20.99,
    gradePoint: null,
    description: 'Needs improvement',
  },
];

/**
 * Writes the scale for each Institution, the band of place `n` keyed by `idOf(institution, n)`. Safe to run twice:
 * rows are keyed by their fixed IDs.
 */
export async function insertGradeBands(
  db: Kysely<unknown>,
  institutionIds: readonly string[],
  idOf: (institutionIndex: number, bandIndex: number) => string,
): Promise<void> {
  for (const [i, institutionId] of institutionIds.entries()) {
    const societyId = await scopeTo(db, institutionId, `grade bands of ${institutionId}`);
    for (const [n, band] of gradeScale.entries()) {
      await sql`
        insert into grade_bands (id, society_id, institution_id, name, min_percentage, max_percentage, grade_point,
          description)
        values (${idOf(i, n)}, ${societyId}, ${institutionId}, ${band.name}, ${band.minPercentage},
          ${band.maxPercentage}, ${band.gradePoint}, ${band.description})
        on conflict (id) do nothing
      `.execute(db);
    }
  }
  await clearScope(db);
}

/** The seeded band of this name in a two-worlds Institution, so a test can find its row. */
export function seededGradeBandId(institutionKey: string, name: string): string {
  const index = institutions.findIndex((i) => i.key === institutionKey);
  if (index < 0) throw new Error(`Unknown two-worlds Institution ${institutionKey}`);
  const band = gradeScale.findIndex((b) => b.name === name);
  if (band < 0) throw new Error(`No seeded grade band ${name}`);
  return seedId(9001 + index * 20 + band);
}

export interface SeedExam {
  name: string;
  /** 1 Unit test, 2 Mid term, 3 Final, 4 Quarterly, 5 Half yearly, 6 Annual. */
  examType: number;
  startDate: string;
  endDate: string;
}

/** The exams of a school's year 2026-2027 (June to March): a unit test, a mid-term and the annual exam. */
export const examsOfTheYear: readonly SeedExam[] = [
  { name: 'Unit Test 1', examType: 1, startDate: '2026-08-10', endDate: '2026-08-14' },
  { name: 'Term 1', examType: 2, startDate: '2026-09-21', endDate: '2026-09-30' },
  { name: 'Annual', examType: 6, startDate: '2027-03-01', endDate: '2027-03-15' },
];

/**
 * Writes each exam of the year for each Institution, with its year, the exam of place `n` keyed by
 * `idOf(institution, n)`. Safe to run twice: rows are keyed by their fixed IDs.
 */
export async function insertExams(
  db: Kysely<unknown>,
  places: readonly { institutionId: string; academicYearId: string }[],
  idOf: (institutionIndex: number, examIndex: number) => string,
): Promise<void> {
  for (const [i, place] of places.entries()) {
    const societyId = await scopeTo(db, place.institutionId, `exams of ${place.institutionId}`);
    for (const [n, exam] of examsOfTheYear.entries()) {
      await sql`
        insert into exams (id, society_id, institution_id, academic_year_id, name, exam_type, start_date, end_date)
        values (${idOf(i, n)}, ${societyId}, ${place.institutionId}, ${place.academicYearId}, ${exam.name},
          ${exam.examType}, ${exam.startDate}, ${exam.endDate})
        on conflict (id) do nothing
      `.execute(db);
    }
  }
  await clearScope(db);
}

/** The seeded exam of this name in a two-worlds Institution, so a test can find its row. */
export function seededExamId(institutionKey: string, name: string): string {
  const index = institutions.findIndex((i) => i.key === institutionKey);
  if (index < 0) throw new Error(`Unknown two-worlds Institution ${institutionKey}`);
  const exam = examsOfTheYear.findIndex((e) => e.name === name);
  if (exam < 0) throw new Error(`No seeded exam ${name}`);
  return seedId(10001 + index * 10 + exam);
}

interface SeedPaper {
  institution: 'A1' | 'B1';
  /** The class by its place in the seeded list, and the section in it. */
  classIndex: number;
  sectionIndex: number;
  /** The invigilator, by persona (the seeded teachers all teach Mathematics, so the same one marks it). */
  teacher: string;
}

/**
 * The Mathematics paper of Unit Test 1 for the sections that have a timetable, on the first day of the test. Every
 * world has one, so a test can show one Society's datesheet is hidden from another.
 */
export const papers: readonly SeedPaper[] = [
  { institution: 'A1', classIndex: 0, sectionIndex: 0, teacher: 'IA-A12' },
  { institution: 'B1', classIndex: 3, sectionIndex: 0, teacher: 'T-B1' },
];

/** The seeded paper of a two-worlds Institution, so a test can find its row. */
export function seededPaperId(institutionKey: string): string {
  const index = papers.findIndex((p) => p.institution === institutionKey);
  if (index < 0) throw new Error(`No seeded paper in ${institutionKey}`);
  return seedId(10201 + index);
}

/**
 * Every two-worlds Institution grades on the same scale and holds the same exams, and two hold a paper, so a test can
 * show one Society's rows are hidden from another. Safe to run twice.
 */
export async function writeExamsSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  await insertGradeBands(
    tx,
    institutions.map((i) => i.id),
    (i, n) => seededGradeBandId(institutions[i]!.key, gradeScale[n]!.name),
  );
  await insertExams(
    tx,
    institutions.map((i) => ({ institutionId: i.id, academicYearId: seededYearId(i.key) })),
    (i, n) => seededExamId(institutions[i]!.key, examsOfTheYear[n]!.name),
  );
  for (const paper of papers) {
    const institution = institutions.find((i) => i.key === paper.institution)!;
    const societyId = await scopeTo(tx, institution.id, `paper of ${paper.institution}`);
    const teacher = seededStaffId(paper.teacher);
    await sql`
      insert into exam_papers (id, society_id, institution_id, academic_year_id, exam_id, section_id, subject_id,
        exam_date, start_time, end_time, room_name, max_marks, passing_marks, subject_teacher_staff_member_id,
        invigilator_staff_member_id)
      select ${seededPaperId(paper.institution)}, ${societyId}, ${institution.id}, ${seededYearId(paper.institution)},
        ${seededExamId(paper.institution, 'Unit Test 1')},
        ${classes[paper.classIndex]!.sections[paper.sectionIndex]!.id},
        (select id from subjects where society_id = ${societyId} and code = 'MATH'),
        ${examsOfTheYear[0]!.startDate}, '09:00', '11:00', 'Room 1', 100, 35, ${teacher}::uuid, ${teacher}::uuid
      on conflict (id) do nothing
    `.execute(tx);
  }
  await clearScope(tx);
}
