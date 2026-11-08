import { sql, type Kysely } from 'kysely';

const ROLLBACK = 'rollback';

/**
 * `files` rows with the forced row-level security lifted for one rolled-back transaction, so a test can see what
 * the API stored whatever Society it belongs to. `db` connects as the table owner.
 */
export async function readFileRows<T>(db: Kysely<unknown>, id: string): Promise<T | undefined> {
  let found: T | undefined;
  await db
    .transaction()
    .execute(async (trx) => {
      await sql`alter table files no force row level security`.execute(trx);
      found = (await sql`select * from files where id = ${id}`.execute(trx)).rows[0] as
        T | undefined;
      throw new Error(ROLLBACK);
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    });
  return found;
}
