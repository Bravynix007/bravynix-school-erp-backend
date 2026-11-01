import { sql, type Kysely } from 'kysely';
import { institutions, personaByKey } from './two-worlds.js';

const rateId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** What each two-worlds Institution is charged per student, from the start of the financial year 2026-27. */
export const ratePerStudent = '50.00';
export const rateEffectiveFrom = '2026-04-01';

/** The seeded rate of an Institution, so a test can find its row. */
export const seededRateId = (institutionKey: string): string => {
  const index = institutions.findIndex((i) => i.key === institutionKey);
  if (index < 0) throw new Error(`Unknown two-worlds Institution ${institutionKey}`);
  return rateId(3001 + index);
};

/**
 * Writes one rate for each two-worlds Institution, by the first Super Admin.
 * Runs after the identity seed, which writes that person.
 *
 * Safe to run twice: rows are keyed by their fixed IDs.
 */
export async function writeBillingSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return write(db);
  await db.transaction().execute(write);
}

async function write(db: Kysely<unknown>): Promise<void> {
  // Rates are Super Admin's to read and write, so the seed writes as Super Admin.
  await sql`select set_config('app.role_code', '1', true)`.execute(db);
  const superAdmin = personaByKey('SA1');
  for (const institution of institutions) {
    await sql`
      insert into institution_price_rates
        (id, society_id, institution_id, rate_per_student_amount, effective_from_date, note, created_by)
      select ${seededRateId(institution.key)}, society_id, id, ${ratePerStudent}, ${rateEffectiveFrom},
        'Seeded rate', ${superAdmin.id}
      from institutions where id = ${institution.id}
      on conflict (id) do nothing
    `.execute(db);
  }
}
