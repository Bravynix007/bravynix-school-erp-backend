/** Result and error codes of the login endpoints (API design 6.2, 10.1 to 10.4). */
export const AuthCode = {
  OTP_SENT_IF_REGISTERED: 'OTP_SENT_IF_REGISTERED',
  OTP_RESEND_TOO_SOON: 'OTP_RESEND_TOO_SOON',
  OTP_REQUEST_LIMIT: 'OTP_REQUEST_LIMIT',
  AUTH_LOCKED: 'AUTH_LOCKED',
} as const;

/** Client types of API design 10.1. */
export const ClientType = { Mobile: 1, Console: 2 } as const;
export type ClientType = (typeof ClientType)[keyof typeof ClientType];

/** `users.account_status` (DDD 9.1). */
export const AccountStatus = { Inactive: 0, Active: 1, Blocked: 2, Pending: 3 } as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];
