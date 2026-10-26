import { sql, type Kysely } from 'kysely';

/**
 * A Society code is unique ignoring case (API design 10.4b): "SUNRISE" and
 * "Sunrise" are one code, as an Institution's code already is (PRD 7.1). The
 * exact-match constraint from the first migration stays; it is now redundant,
 * and migrations only add in the release that needs them (SDD 16.6).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create unique index uq_societies_code_ci on societies (lower(code))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop the Society code index in production: two Societies could then share a code',
    );
  }
  await sql`drop index if exists uq_societies_code_ci`.execute(db);
}
