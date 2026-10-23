import type { Migration, MigrationProvider } from 'kysely/migration';
import * as m0001 from './2026_10_23_0001_foundation.js';

/**
 * Every migration, in order. Listed explicitly (not read from disk) so the
 * build is the single source of truth and nothing runs that was not
 * reviewed. Name files `YYYY_MM_DD_NNNN_<module>_<change>.ts`.
 *
 * Migrations only add in the release that needs them; removing or renaming
 * happens in a later release (SDD 16.6).
 */
const migrations: Record<string, Migration> = {
  '2026_10_23_0001_foundation': m0001,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};
