export { IdentityModule } from './identity.module.js';
export { OtpService, type OtpRequest, type OtpRequestResult } from './otp.service.js';
export { AccountStatus, AuthCode, ClientType } from './auth-codes.js';
export type {
  OtpChallengesTable,
  PublicCallCountersTable,
  RoleAssignmentsTable,
  UsersTable,
} from './identity.tables.js';
