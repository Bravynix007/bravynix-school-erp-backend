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
  // Field codes
  REQUIRED: 'This field is required',
  FIELD_NOT_ALLOWED: 'This field is not allowed',
  INVALID_TYPE: 'This value has the wrong type',
  INVALID_FORMAT: 'This value has the wrong format',
  TOO_SHORT: 'This value is too short',
  TOO_LONG: 'This value is too long',
  INVALID_VALUE: 'This value is not allowed',
};

const catalogues: Partial<Record<Language, Catalogue>> = { en };

export function resolveLanguage(acceptLanguage: string | undefined): Language {
  if (!acceptLanguage) return 'en';
  const tags = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', q] = part.trim().split(';q=');
      return { lang: tag.toLowerCase().split('-')[0], q: q === undefined ? 1 : Number(q) };
    })
    .toSorted((a, b) => b.q - a.q);
  const match = tags.find((t) => (SUPPORTED_LANGUAGES as readonly string[]).includes(t.lang ?? ''));
  return (match?.lang as Language | undefined) ?? 'en';
}

export function message(code: string, language: Language = 'en'): string {
  return catalogues[language]?.[code] ?? en[code] ?? code;
}
