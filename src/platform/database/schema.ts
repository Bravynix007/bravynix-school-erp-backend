import type { AuditLogsTable } from '../audit/audit.tables.js';
import type {
  AuthSessionsTable,
  LoginLockoutsTable,
  OtpChallengesTable,
  PublicCallCountersTable,
  RefreshTokensTable,
  RoleAssignmentsTable,
  UsersTable,
} from '../identity/identity.tables.js';

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
}
