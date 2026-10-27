import { existsSync } from 'node:fs';
import pg from 'pg';
import { runMigrations } from '../platform/database/migrator.js';
import { assertSeedable } from './seed-guard.js';
import { seedScenario } from './seed-runner.js';

/**
 * `npm run demo:reset` drops the demo database, builds it again and writes the demo scenario, so a demo can always
 * start from the same clean state. It touches only `school_erp_demo` on a local server, and only as the database
 * administrator named by `DEMO_ADMIN_URL` (default: the `postgres` user of docker compose).
 */
const DEMO_DATABASE = 'school_erp_demo';
const DEFAULT_ADMIN_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

async function main(): Promise<void> {
  if (existsSync('demo.env')) process.loadEnvFile('demo.env');
  const nodeEnv = process.env.NODE_ENV;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!migrationUrl) throw new Error('Set DATABASE_MIGRATION_URL (demo.env does)');
  if (new URL(migrationUrl).pathname !== `/${DEMO_DATABASE}`) {
    throw new Error(
      `demo:reset only rebuilds ${DEMO_DATABASE}, not ${new URL(migrationUrl).pathname.slice(1)}`,
    );
  }
  assertSeedable(migrationUrl, nodeEnv);
  const adminUrl = process.env.DEMO_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  assertSeedable(adminUrl, nodeEnv);

  const admin = new pg.Client({ connectionString: withDatabase(adminUrl, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${DEMO_DATABASE} with (force)`);
    await admin.query(`create database ${DEMO_DATABASE} owner erp_migrator`);
  } finally {
    await admin.end();
  }
  // The schema belongs to the migration user, and the app user may connect (the same setup as docker/postgres/init.sql).
  const inside = new pg.Client({ connectionString: withDatabase(adminUrl, DEMO_DATABASE) });
  await inside.connect();
  try {
    await inside.query('alter schema public owner to erp_migrator');
    await inside.query(`grant connect on database ${DEMO_DATABASE} to erp_app`);
  } finally {
    await inside.end();
  }

  const { error } = await runMigrations(migrationUrl, 'latest');
  if (error) throw error;
  for (const line of await seedScenario('demo', migrationUrl, nodeEnv)) console.log(line);
  console.log(
    `\nThe demo database ${DEMO_DATABASE} is ready. Start the API with: npm run demo:api`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
