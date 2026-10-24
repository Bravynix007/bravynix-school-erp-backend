import '../bootstrap/load-env.js';
import { runMigrations, type MigrateCommand } from '../platform/database/migrator.js';

const COMMANDS: MigrateCommand[] = ['latest', 'down', 'reset'];

async function main(): Promise<void> {
  const command = (process.argv[2] ?? 'latest') as MigrateCommand;
  if (!COMMANDS.includes(command)) {
    throw new Error(`Unknown command "${command}". Use one of: ${COMMANDS.join(', ')}`);
  }
  if (command === 'reset' && ['staging', 'production'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('reset is refused in staging and production');
  }
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_MIGRATION_URL (or DATABASE_URL)');

  const { error, results } = await runMigrations(url, command);
  for (const result of results ?? []) {
    console.log(`${result.status.padEnd(7)} ${result.direction.padEnd(4)} ${result.migrationName}`);
  }
  if (!results?.length) console.log('Nothing to do');
  if (error) throw error;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
