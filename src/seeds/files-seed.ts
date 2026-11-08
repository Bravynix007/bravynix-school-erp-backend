import { sql, type Kysely } from 'kysely';
import { clearScope, scopeTo } from './academic-seed.js';
import { institutions } from './two-worlds.js';

const seedId = (n: number): string => `00000000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

/** The seeded upload of a two-worlds Institution, so a test can find its row. */
export const seededFileId = (institutionKey: string): string => {
  const index = institutions.findIndex((i) => i.key === institutionKey);
  if (index < 0) throw new Error(`Unknown two-worlds Institution ${institutionKey}`);
  return seedId(3301 + index);
};

/**
 * One upload asked for and not yet sent (a Pending student photo) in every two-worlds Institution, so a test can
 * show one Society's files are hidden from another. Nothing is stored for it: it is the row FIL-01 writes. Safe to
 * run twice: rows are keyed by their fixed IDs.
 */
export async function writeFilesSeed(db: Kysely<unknown>): Promise<void> {
  if (db.isTransaction) return writeIn(db);
  await db.transaction().execute(writeIn);
}

async function writeIn(tx: Kysely<unknown>): Promise<void> {
  for (const institution of institutions) {
    const societyId = await scopeTo(tx, institution.id, 'file');
    await sql`
      insert into files (id, society_id, institution_id, storage_bucket, object_key, purpose, content_type, size_bytes, delete_after)
      values (${seededFileId(institution.key)}, ${societyId}, ${institution.id}, 1,
        ${`${societyId}/${institution.id}/3/seeded`}, 3, 'image/jpeg', 1024, now() + interval '24 hours')
      on conflict (id) do nothing
    `.execute(tx);
  }
  await clearScope(tx);
}
