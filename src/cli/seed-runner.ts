import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool } from '../platform/database/database.service.js';
import {
  institutions as demoInstitutions,
  people as demoPeople,
  societies as demoSocieties,
  writeDemoSeed,
} from '../seeds/demo.js';
import { writeIdentitySeed } from '../seeds/identity-seed.js';
import { children, institutions, personas, societies } from '../seeds/two-worlds.js';
import { assertSeedable } from './seed-guard.js';

type SeedWriter = (db: Kysely<unknown>) => Promise<void>;

interface Scenario {
  /** Each module that owns tables registers a writer here as it is built. */
  writers: SeedWriter[];
  summary: () => string[];
}

export const SCENARIOS: Record<string, Scenario> = {
  'two-worlds': {
    // Writes the Societies and Institutions first, then the people and their grants.
    // Staff and role 3 grants join with the People module.
    writers: [writeIdentitySeed],
    summary: () => [
      `Scenario two-worlds: ${societies.length} Societies, ${institutions.length} Institutions,`,
      `${personas.length} personas, ${children.length} children.`,
      ...personas.map((p) => `  ${p.key.padEnd(16)} ${p.email.padEnd(36)} ${p.status}`),
    ],
  },
  demo: {
    writers: [writeDemoSeed],
    summary: () => [
      `Scenario demo: ${demoSocieties.length} Societies, ${demoInstitutions.length} Institutions, ${demoPeople.length} people.`,
      ...demoPeople.map((p) => `  ${p.email}`),
    ],
  },
};

/**
 * Writes a named data set into a local or test database, in one transaction. Refused in staging and production,
 * and for any non-local host.
 */
export async function seedScenario(
  name: string,
  url: string,
  nodeEnv: string | undefined,
): Promise<string[]> {
  const scenario = SCENARIOS[name];
  if (!scenario)
    throw new Error(`Unknown scenario "${name}". Use one of: ${Object.keys(SCENARIOS).join(', ')}`);
  assertSeedable(url, nodeEnv);

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: createPool(url, 1, 60_000) }),
  });
  try {
    const migrated = await sql<{ count: number }>`
      select count(*)::int as count from information_schema.tables where table_name = 'schema_migrations'
    `.execute(db);
    if (!migrated.rows[0]?.count) throw new Error('Run `npm run db:migrate` first');

    await db.transaction().execute(async (tx) => {
      for (const write of scenario.writers) await write(tx);
    });
    return scenario.summary();
  } finally {
    await db.destroy();
  }
}
