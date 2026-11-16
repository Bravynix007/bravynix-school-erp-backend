import { sql, type Kysely } from 'kysely';

/**
 * Runs `work` as the table owner with the forced row-level security of `tables` lifted for the length of one
 * transaction, and with the `updated_at` trigger of `documents` off, so a test can age a row the API made (a document
 * deactivated a month ago, an import run that finished last week). The settings go back before the commit.
 */
export async function asOwnerOf(
  db: Kysely<unknown>,
  tables: readonly string[],
  work: (tx: Kysely<unknown>) => Promise<void>,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    for (const table of tables)
      await sql`alter table ${sql.table(table)} no force row level security`.execute(tx);
    if (tables.includes('documents')) {
      await sql`alter table documents disable trigger trg_documents_updated`.execute(tx);
    }
    await work(tx);
    if (tables.includes('documents')) {
      await sql`alter table documents enable trigger trg_documents_updated`.execute(tx);
    }
    for (const table of tables)
      await sql`alter table ${sql.table(table)} force row level security`.execute(tx);
  });
}
