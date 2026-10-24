import '../bootstrap/load-env.js';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool } from '../platform/database/database.service.js';
import { children, institutions, personas, societies } from '../seeds/two-worlds.js';
import { assertSeedable } from './seed-guard.js';

/**
 * `npm run db:seed [scenario]` writes a named data set into a local or test
 * database. Refused in staging and production, and for any non-local host.
 *
 * Each module that owns tables registers a writer here as it is built; until
 * the Identity and Tenancy modules exist, the two-worlds scenario only checks
 * the schema is migrated and prints the personas it will create.
 */
type SeedWriter = (db: Kysely<unknown>) => Promise<void>;

const writers: SeedWriter[] = [
  // Phase 1: identity + tenancy writers go here.
];

async function main(): Promise<void> {
  const scenario = process.argv[2] ?? 'two-worlds';
  if (scenario !== 'two-worlds') throw new Error(`Unknown scenario "${scenario}"`);
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_MIGRATION_URL (or DATABASE_URL)');
  assertSeedable(url, process.env.NODE_ENV);

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: createPool(url, 1, 60_000) }),
  });
  try {
    const migrated = await sql<{ count: number }>`
      select count(*)::int as count from information_schema.tables where table_name = 'schema_migrations'
    `.execute(db);
    if (!migrated.rows[0]?.count) throw new Error('Run `npm run db:migrate` first');

    await db.transaction().execute(async (tx) => {
      for (const write of writers) await write(tx);
    });

    console.log(
      `Scenario two-worlds: ${societies.length} Societies, ${institutions.length} Institutions,`,
    );
    console.log(`${personas.length} personas, ${children.length} children.`);
    if (writers.length === 0) {
      console.log('No tables to fill yet: writers arrive with the Identity and Tenancy modules.');
    }
    for (const p of personas)
      console.log(`  ${p.key.padEnd(16)} ${p.email.padEnd(36)} ${p.status}`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
