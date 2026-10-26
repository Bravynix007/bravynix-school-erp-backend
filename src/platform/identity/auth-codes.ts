/** Result and error codes of the login endpoints (API design 6.2, 10.1 to 10.4). */
export const AuthCode = {
  OTP_SENT_IF_REGISTERED: 'OTP_SENT_IF_REGISTERED',
  OTP_RESEND_TOO_SOON: 'OTP_RESEND_TOO_SOON',
  OTP_REQUEST_LIMIT: 'OTP_REQUEST_LIMIT',
  AUTH_LOCKED: 'AUTH_LOCKED',
  LOGIN_OK: 'LOGIN_OK',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  CONSOLE_NOT_ALLOWED: 'CONSOLE_NOT_ALLOWED',
} as const;

/** Client types of API design 10.1. */
export const ClientType = { Mobile: 1, Console: 2 } as const;
export type ClientType = (typeof ClientType)[keyof typeof ClientType];

/** `users.account_status` (DDD 9.1). */
export const AccountStatus = { Inactive: 0, Active: 1, Blocked: 2, Pending: 3 } as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

/** `auth_sessions.end_reason` (DDD 9.1). */
export const SessionEndReason = {
  Logout: 1,
  LogoutAll: 2,
  AccountBlocked: 3,
  AccessRevoked: 4,
  RefreshTokenReused: 5,
  Expired: 6,
  EmailChanged: 7,
} as const;
export type SessionEndReason = (typeof SessionEndReason)[keyof typeof SessionEndReason];

/** `userTypeName` for each role code (API design 10.2). */
const USER_TYPE_NAMES = {
  1: 'super_admin',
  2: 'society_owner',
  3: 'institution_admin',
  4: 'teacher_staff',
  5: 'student_parent',
} as const;
export type UserTypeName = (typeof USER_TYPE_NAMES)[keyof typeof USER_TYPE_NAMES];

/** The role a session is acting as, named for the client; null until a context is active. */
export function userTypeFor(
  roleCode: number | null,
): { userType: number; userTypeName: UserTypeName } | { userType: null; userTypeName: null } {
  const name =
    roleCode === null ? undefined : USER_TYPE_NAMES[roleCode as keyof typeof USER_TYPE_NAMES];
  return name === undefined || roleCode === null
    ? { userType: null, userTypeName: null }
    : { userType: roleCode, userTypeName: name };
}
