import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, NO_MIGRATIONS, type MigrationResultSet } from 'kysely/migration';
import { createPool } from './database.service.js';
import { migrationProvider } from './migrations/index.js';

export type MigrateCommand = 'latest' | 'down' | 'reset';

/** Runs migrations with the migration user (schema owner), never the app user. */
export async function runMigrations(
  connectionString: string,
  command: MigrateCommand,
): Promise<MigrationResultSet> {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: createPool(connectionString, 1, 600_000) }),
  });
  const migrator = new Migrator({
    db,
    provider: migrationProvider,
    migrationTableName: 'schema_migrations',
    migrationLockTableName: 'schema_migrations_lock',
  });
  try {
    if (command === 'latest') return await migrator.migrateToLatest();
    if (command === 'down') return await migrator.migrateDown();
    return await migrator.migrateTo(NO_MIGRATIONS);
  } finally {
    await db.destroy();
  }
}
