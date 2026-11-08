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

/** How many `files` rows exist, whatever Society they belong to (forced row-level security lifted, rolled back). */
export async function countFileRows(db: Kysely<unknown>): Promise<number> {
  let count = 0;
  await db
    .transaction()
    .execute(async (trx) => {
      await sql`alter table files no force row level security`.execute(trx);
      count = (await sql<{ n: number }>`select count(*)::int as n from files`.execute(trx)).rows[0]!
        .n;
      throw new Error(ROLLBACK);
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    });
  return count;
}
