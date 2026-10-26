import { sql, type Kysely, type RawBuilder } from 'kysely';

const ROLLBACK = 'rollback';

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
      throw new Error(ROLLBACK);
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    });
  return found;
}

/**
 * Every row of the named tables (and the audit log) as one text, for a test
 * that proves a secret is stored nowhere. Reads in a rolled-back transaction
 * that lifts the forced policy on `audit_logs`, and raises any error other
 * than the rollback, so a failed read cannot pass as an empty dump.
 */
export async function dumpTables(db: Kysely<unknown>, tables: readonly string[]): Promise<string> {
  let dump = '';
  await db
    .transaction()
    .execute(async (trx) => {
      await sql`alter table audit_logs no force row level security`.execute(trx);
      for (const table of [...tables, 'audit_logs']) {
        const { rows } = await sql<{ text: string | null }>`
          select string_agg(t::text, '|') as text from ${sql.table(table)} t`.execute(trx);
        dump += `|${rows[0]?.text ?? ''}`;
      }
      throw new Error(ROLLBACK);
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    });
  return dump;
}
