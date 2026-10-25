export { IdentityModule } from './identity.module.js';
export { OtpService, type OtpRequest, type OtpRequestResult } from './otp.service.js';
export { AccountStatus, AuthCode, ClientType } from './auth-codes.js';
export type {
  OtpChallengesTable,
  PublicCallHitsTable,
  RoleAssignmentsTable,
  UsersTable,
} from './identity.tables.js';
