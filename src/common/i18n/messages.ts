/**
 * User-facing messages per result code, in the 7 PRD languages
 * (API design 7.1). English is complete; other languages fall back to English
 * until translations are added. Messages must be safe to show to any user.
 */
export const SUPPORTED_LANGUAGES = ['en', 'hi', 'kn', 'ml', 'mr', 'ta', 'te'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

type Catalogue = Record<string, string>;

const en: Catalogue = {
  OK: 'OK',
  CREATED: 'Created',
  ACCEPTED: 'Accepted',
  MALFORMED_JSON: 'The request body is not valid JSON',
  VALIDATION_FAILED: 'Please correct the highlighted fields',
  IDEMPOTENCY_KEY_REQUIRED: 'An Idempotency-Key header is required for this request',
  OUT_OF_RANGE: 'A value is out of the allowed range',
  INVALID_SORT: 'This list cannot be sorted that way',
  CURSOR_INVALID: 'This page link is no longer valid, please reload the list',
  RANGE_TOO_LARGE: 'Please choose a shorter date range',
  TOKEN_INVALID: 'Please sign in again',
  TOKEN_EXPIRED: 'Your session has expired, please sign in again',
  SESSION_ENDED: 'You have been signed out',
  FORBIDDEN: 'You are not authorized to view this page',
  NOT_ASSIGNED: 'You are not assigned to this class or subject',
  ACCESS_BLOCKED: 'Your access has been blocked, please contact your Institution',
  SUPPORT_READ_ONLY: 'Support access is read-only',
  NOT_FOUND: 'Not found',
  VERSION_CONFLICT: 'Someone else changed this; your changes were not saved',
  INVALID_STATE: 'This action is not possible right now',
  DUPLICATE: 'This already exists',
  IDEMPOTENCY_IN_PROGRESS: 'This request is already being processed',
  PAYLOAD_TOO_LARGE: 'The request is too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported content type',
  IDEMPOTENCY_KEY_REUSED: 'This request key was already used for a different request',
  ACCESS_PAUSED: 'Access paused, please contact your Society',
  APP_UPDATE_REQUIRED: 'Please update the app to continue',
  RATE_LIMITED: 'Too many requests, please try again shortly',
  INTERNAL_ERROR: 'Something went wrong',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable, please try again',
  // Login (API design 6.2, 10.1, 10.2)
  OTP_SENT_IF_REGISTERED: 'If this email is registered, a code has been sent',
  OTP_RESEND_TOO_SOON: 'Please wait a minute before asking for another code',
  OTP_REQUEST_LIMIT: 'Too many code requests, please try again later',
  AUTH_LOCKED: 'Too many failed attempts, please try again later',
  LOGIN_OK: 'Welcome back',
  OTP_INVALID: 'That code is not correct',
  OTP_EXPIRED: 'That code has expired, please ask for a new one',
  OTP_ATTEMPTS_EXCEEDED: 'Too many wrong codes, please try again later',
  ACCOUNT_BLOCKED: "This account is blocked and can't access the app",
  CONSOLE_NOT_ALLOWED: 'This account cannot sign in to the console',
  MFA_REQUIRED: 'Enter the code from your authenticator app',
  MFA_SETUP_STARTED: 'Scan the code with your authenticator app, then enter the code it shows',
  MFA_INVALID: 'That authenticator code is not correct',
  MFA_TOKEN_EXPIRED: 'This sign-in has timed out, please start again',
  MFA_NOT_ENROLLED: 'Set up your authenticator app first',
  MFA_ALREADY_ENROLLED: 'An authenticator app is already set up for this account',
  REFRESH_OK: 'Session renewed',
  REFRESH_TOKEN_INVALID: 'Please sign in again',
  REFRESH_TOKEN_REUSED: 'For your safety you have been signed out, please sign in again',
  LOGOUT_OK: 'You have been signed out',
  LOGOUT_ALL_OK: 'You have been signed out of every device',
  CONTEXT_NOT_AVAILABLE: 'You do not have access to that role',
  CONTEXT_SWITCHED: 'Role changed',
  // Field codes
  REQUIRED: 'This field is required',
  FIELD_NOT_ALLOWED: 'This field is not allowed',
  INVALID_TYPE: 'This value has the wrong type',
  INVALID_FORMAT: 'This value has the wrong format',
  TOO_SHORT: 'This value is too short',
  TOO_LONG: 'This value is too long',
  TOO_FEW: 'Add more items',
  TOO_MANY: 'There are too many items',
  INVALID_CODE: 'This value is not in the list',
  INVALID_VALUE: 'This value is not allowed',
};

const catalogues: Partial<Record<Language, Catalogue>> = { en };

export function resolveLanguage(acceptLanguage: string | undefined): Language {
  if (!acceptLanguage) return 'en';
  const tags = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', q] = part.trim().split(';q=');
      const weight = q === undefined ? 1 : Number(q);
      // A malformed weight counts as 1; q=0 means "not acceptable" (RFC 9110 12.4.2).
      return { lang: tag.toLowerCase().split('-')[0], q: Number.isFinite(weight) ? weight : 1 };
    })
    .filter((t) => t.q > 0)
    .toSorted((a, b) => b.q - a.q);
  const match = tags.find((t) => (SUPPORTED_LANGUAGES as readonly string[]).includes(t.lang ?? ''));
  return (match?.lang as Language | undefined) ?? 'en';
}

export function message(code: string, language: Language = 'en'): string {
  return catalogues[language]?.[code] ?? en[code] ?? code;
}
