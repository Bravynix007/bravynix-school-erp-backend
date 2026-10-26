import type { Migration, MigrationProvider } from 'kysely/migration';
import * as m0001 from './2026_10_23_0001_foundation.js';
import * as m0002 from './2026_10_25_0002_audit_logs.js';
import * as m0003 from './2026_10_25_0003_identity_users_otp.js';
import * as m0004 from './2026_10_25_0004_identity_sessions.js';
import * as m0005 from './2026_10_26_0005_identity_call_scope.js';

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
  '2026_10_25_0002_audit_logs': m0002,
  '2026_10_25_0003_identity_users_otp': m0003,
  '2026_10_25_0004_identity_sessions': m0004,
  '2026_10_26_0005_identity_call_scope': m0005,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};
