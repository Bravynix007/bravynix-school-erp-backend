import '../bootstrap/load-env.js';
import { seedScenario } from './seed-runner.js';

/**
 * `npm run db:seed [scenario]` writes a named data set (`two-worlds`, the default, or `demo`) into a local or
 * test database. Refused in staging and production, and for any non-local host.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_MIGRATION_URL (or DATABASE_URL)');
  for (const line of await seedScenario(
    process.argv[2] ?? 'two-worlds',
    url,
    process.env.NODE_ENV,
  )) {
    console.log(line);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
