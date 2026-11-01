import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { createPool } from '../../src/platform/database/database.service.js';
import { migrationProvider } from '../../src/platform/database/migrations/index.js';

/**
 * Moves the database to just after the named migration, so a test of one
 * migration does not break when a later one is added. It rolls back when the
 * database is ahead and migrates forward when it is behind.
 */
export async function rollBackTo(connectionString: string, migrationName: string) {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: createPool(connectionString, 1, 600_000) }),
  });
  try {
    return await new Migrator({
      db,
      provider: migrationProvider,
      migrationTableName: 'schema_migrations',
      migrationLockTableName: 'schema_migrations_lock',
    }).migrateTo(migrationName);
  } finally {
    await db.destroy();
  }
}
