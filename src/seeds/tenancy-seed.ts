import { sql, type Kysely } from 'kysely';
import { institutions, societies } from './two-worlds.js';

/**
 * Writes the two-worlds Societies and Institutions. Runs before the identity
 * seed, whose Society Owner grants point at these rows.
 *
 * Safe to run twice: rows are keyed by their fixed IDs. Addresses and names are
 * placeholders; nothing here is real.
 */
export async function writeTenancySeed(db: Kysely<unknown>): Promise<void> {
  // The tenant roots force row-level security even on their owner, so the seed
  // writes as Super Admin, for this transaction only.
  if (db.isTransaction) return write(db);
  await db.transaction().execute(write);
}

async function write(db: Kysely<unknown>): Promise<void> {
  await sql`select set_config('app.role_code', '1', true)`.execute(db);
  for (const society of societies) {
    await sql`
      insert into societies (id, name, code)
      values (${society.id}, ${society.name}, ${society.key})
      on conflict (id) do nothing
    `.execute(db);
  }
  for (const institution of institutions) {
    const society = societies.find((s) => s.key === institution.society);
    if (!society) throw new Error(`Institution ${institution.key} names an unknown Society`);
    await sql`
      insert into institutions (id, society_id, name, code, address_line_1)
      values (${institution.id}, ${society.id}, ${institution.name}, ${institution.code}, 'Seeded address')
      on conflict (id) do nothing
    `.execute(db);
  }
}
