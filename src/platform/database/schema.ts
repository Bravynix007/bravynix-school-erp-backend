import type { AuditLogsTable } from '../audit/audit.tables.js';
import type {
  AuthSessionsTable,
  LoginLockoutsTable,
  LoginUnlocksTable,
  MfaChallengesTable,
  OtpChallengesTable,
  PublicCallCountersTable,
  RefreshTokensTable,
  RoleAssignmentsTable,
  UserTotpFactorsTable,
  UsersTable,
} from '../identity/identity.tables.js';
import type {
  CitiesTable,
  ClassCategoriesTable,
  CountriesTable,
  DesignationsTable,
  PredefinedClassesTable,
  PredefinedSectionsTable,
  StatesTable,
} from '../masters/masters.tables.js';
import type { NumberSequencesTable } from '../numbering/numbering.tables.js';
import type { IdempotencyKeysTable } from '../idempotency/idempotency.tables.js';
import type {
  AccessBlocksTable,
  InstitutionsTable,
  SocietiesTable,
} from '../tenancy/tenancy.tables.js';

/**
 * Kysely table types, one interface per table, added by the module that owns
 * the table in the same PR as its migration. Module code only ever touches
 * its own tables (SDD 9.3 rule 1).
 */
export interface Database {
  audit_logs: AuditLogsTable;
  users: UsersTable;
  role_assignments: RoleAssignmentsTable;
  otp_challenges: OtpChallengesTable;
  public_call_counters: PublicCallCountersTable;
  auth_sessions: AuthSessionsTable;
  refresh_tokens: RefreshTokensTable;
  login_lockouts: LoginLockoutsTable;
  login_unlocks: LoginUnlocksTable;
  user_totp_factors: UserTotpFactorsTable;
  mfa_challenges: MfaChallengesTable;
  societies: SocietiesTable;
  institutions: InstitutionsTable;
  access_blocks: AccessBlocksTable;
  idempotency_keys: IdempotencyKeysTable;
  number_sequences: NumberSequencesTable;
  countries: CountriesTable;
  states: StatesTable;
  cities: CitiesTable;
  class_categories: ClassCategoriesTable;
  predefined_classes: PredefinedClassesTable;
  predefined_sections: PredefinedSectionsTable;
  designations: DesignationsTable;
}
