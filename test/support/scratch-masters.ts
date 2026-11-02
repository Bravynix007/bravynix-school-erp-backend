import { sql, type Kysely } from 'kysely';

/** Every master, children first: a city before its state, a state before its country, a class before its category. */
const ALL = [
  'cities',
  'states',
  'countries',
  'predefined_classes',
  'class_categories',
  'predefined_sections',
  'designations',
];
const ORDERED = ALL.slice(3);

/**
 * Takes away the entries a test added to the platform masters and closes the gaps they left in the lists,
 * so the next test starts from the seeded data. The masters force row-level security and have no DELETE
 * policy, so removing needs the force lifted for one transaction. `db` connects as the table owner.
 */
export async function removeScratchMasters(
  db: Kysely<unknown>,
  scratch: readonly { table: string; id: string }[],
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    for (const table of ALL)
      await sql`alter table ${sql.table(table)} no force row level security`.execute(tx);
    await sql`set constraints all deferred`.execute(tx);
    for (const table of ALL) {
      const ids = scratch.filter((entry) => entry.table === table).map((entry) => entry.id);
      if (ids.length) {
        await sql`delete from ${sql.table(table)} where id in (${sql.join(ids)})`.execute(tx);
      }
    }
    for (const table of ORDERED) {
      await sql`
        update ${sql.table(table)} t set display_order = r.rank
        from (select id, row_number() over (order by display_order, id)::int as rank from ${sql.table(table)}) r
        where t.id = r.id and t.display_order <> r.rank
      `.execute(tx);
    }
    for (const table of ALL)
      await sql`alter table ${sql.table(table)} force row level security`.execute(tx);
  });
}
