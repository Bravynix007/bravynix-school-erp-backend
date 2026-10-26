import { sql, type Kysely, type RawBuilder } from 'kysely';

/**
 * Audit rows with no Society (a login) are readable by no tenant session, by
 * design, so the test lifts the forced policy for one rolled-back transaction.
 * `db` connects as the table owner.
 */
export async function readAuditRows<T>(
  db: Kysely<unknown>,
  where: RawBuilder<unknown>,
): Promise<T[]> {
  let found: T[] = [];
  await db
    .transaction()
    .execute(async (trx) => {
      await sql`alter table audit_logs no force row level security`.execute(trx);
      found = (await sql`select * from audit_logs where ${where} order by created_at`.execute(trx))
        .rows as T[];
      throw new Error('rollback');
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'rollback') throw error;
    });
  return found;
}
