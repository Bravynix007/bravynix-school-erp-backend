import { sql, type Kysely } from 'kysely';

/**
 * Scratch Societies for tests that need a real one to point a grant at. The
 * tenant roots force row-level security even on their owner and have no DELETE
 * policy, so writing is done as Super Admin and removing needs the force lifted
 * for the length of one transaction.
 */
export async function createScratchSociety(db: Kysely<unknown>, id: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await sql`select set_config('app.role_code', '1', true)`.execute(tx);
    await sql`insert into societies (id, name, code) values (${id}, 'Scratch', ${id})`.execute(tx);
  });
}

export async function removeScratchSocieties(
  db: Kysely<unknown>,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction().execute(async (tx) => {
    await sql`alter table societies no force row level security`.execute(tx);
    await sql`delete from role_assignments where society_id in (${sql.join(ids)})`.execute(tx);
    await sql`delete from societies where id in (${sql.join(ids)})`.execute(tx);
    await sql`alter table societies force row level security`.execute(tx);
  });
}
