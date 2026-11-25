import { sql, type Kysely } from 'kysely';
import { clearScope, scopeTo } from './academic-seed.js';
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

/**
 * Every two-worlds Institution grades on the same scale, so a test can show one Society's bands are hidden from
 * another. Safe to run twice.
 */
export async function writeExamsSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

function writeIn(tx: Kysely<unknown>): Promise<void> {
  return insertGradeBands(
    tx,
    institutions.map((i) => i.id),
    (i, n) => seededGradeBandId(institutions[i]!.key, gradeScale[n]!.name),
  );
}
