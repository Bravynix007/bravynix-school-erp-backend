export { IdentityModule } from './identity.module.js';
export { OtpService, type OtpRequest, type OtpRequestResult } from './otp.service.js';
export { AccountStatus, AuthCode, ClientType } from './auth-codes.js';
export type {
  AuthSessionsTable,
  LoginLockoutsTable,
  OtpChallengesTable,
  PublicCallCountersTable,
  RefreshTokensTable,
  RoleAssignmentsTable,
  UsersTable,
} from './identity.tables.js';
