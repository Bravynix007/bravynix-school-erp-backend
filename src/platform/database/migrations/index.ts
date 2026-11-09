import type { Migration, MigrationProvider } from 'kysely/migration';
import * as m0001 from './2026_10_23_0001_foundation.js';
import * as m0002 from './2026_10_25_0002_audit_logs.js';
import * as m0003 from './2026_10_25_0003_identity_users_otp.js';
import * as m0004 from './2026_10_25_0004_identity_sessions.js';
import * as m0005 from './2026_10_26_0005_identity_call_scope.js';
import * as m0006 from './2026_10_26_0006_tenancy_core.js';
import * as m0007 from './2026_10_26_0007_identity_mfa.js';
import * as m0008 from './2026_10_26_0008_tenancy_society_code_ci.js';
import * as m0009 from './2026_10_26_0009_identity_login_unlocks.js';
import * as m0010 from './2026_10_27_0010_identity_context_society_name.js';
import * as m0011 from './2026_10_27_0011_tenancy_access_blocks.js';
import * as m0012 from './2026_10_28_0012_billing_price_rates.js';
import * as m0013 from './2026_11_01_0013_platform_idempotency_numbering.js';
import * as m0014 from './2026_11_01_0014_billing_platform_dues.js';
import * as m0015 from './2026_11_02_0015_billing_due_lifecycle.js';
import * as m0016 from './2026_11_02_0016_billing_owner_view.js';
import * as m0017 from './2026_11_02_0017_masters_platform_masters.js';
import * as m0018 from './2026_11_02_0018_academic_years.js';
import * as m0019 from './2026_11_02_0019_subjects.js';
import * as m0020 from './2026_11_02_0020_tenancy_institution_places_classes.js';
import * as m0021 from './2026_11_02_0021_academic_classes_sections.js';
import * as m0022 from './2026_11_08_0022_files.js';
import * as m0023 from './2026_11_08_0023_audit_own_reveals.js';
import * as m0024 from './2026_11_08_0024_people_staff_core.js';
import * as m0025 from './2026_11_08_0025_people_staff_sign_in.js';
import * as m0026 from './2026_11_09_0026_people_staff_elsewhere.js';

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
  '2026_10_26_0006_tenancy_core': m0006,
  '2026_10_26_0007_identity_mfa': m0007,
  '2026_10_26_0008_tenancy_society_code_ci': m0008,
  '2026_10_26_0009_identity_login_unlocks': m0009,
  '2026_10_27_0010_identity_context_society_name': m0010,
  '2026_10_27_0011_tenancy_access_blocks': m0011,
  '2026_10_28_0012_billing_price_rates': m0012,
  '2026_11_01_0013_platform_idempotency_numbering': m0013,
  '2026_11_01_0014_billing_platform_dues': m0014,
  '2026_11_02_0015_billing_due_lifecycle': m0015,
  '2026_11_02_0016_billing_owner_view': m0016,
  '2026_11_02_0017_masters_platform_masters': m0017,
  '2026_11_02_0018_academic_years': m0018,
  '2026_11_02_0019_subjects': m0019,
  '2026_11_02_0020_tenancy_institution_places_classes': m0020,
  '2026_11_02_0021_academic_classes_sections': m0021,
  '2026_11_08_0022_files': m0022,
  '2026_11_08_0023_audit_own_reveals': m0023,
  '2026_11_08_0024_people_staff_core': m0024,
  '2026_11_08_0025_people_staff_sign_in': m0025,
  '2026_11_09_0026_people_staff_elsewhere': m0026,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};
