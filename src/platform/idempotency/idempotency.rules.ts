import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { isUuid } from '../../common/ids/ids.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';

/** How long an answer is kept (API design 14.2). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** The header an operation reads its key from. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** Set on an answer that was stored earlier and is being sent again (API design 14.2). */
export const REPLAYED_HEADER = 'Idempotent-Replayed';

/** A missing key is 400 `IDEMPOTENCY_KEY_REQUIRED`; one that is not a UUID is a validation error on the header. */
export function parseIdempotencyKey(raw: string | string[] | undefined): string {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
  }
  if (typeof raw !== 'string' || !isUuid(raw.trim())) {
    throw AppException.validation([fieldError(IDEMPOTENCY_HEADER, FieldErrorCode.INVALID_FORMAT)]);
  }
  return raw.trim().toLowerCase();
}

/**
 * JSON with every object's keys in order, so the same request always reads the same. An object that
 * knows its JSON (a Date, for one) is read as that; a class instance, such as a validated body DTO,
 * is read as its own fields. A Map or a Set would silently read as `{}` and make two different
 * requests look the same, so they are refused.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Map || value instanceof Set) {
    throw new TypeError('An idempotent request cannot hold a Map or a Set');
  }
  if (value !== null && typeof value === 'object') {
    const { toJSON } = value as { toJSON?: () => unknown };
    if (typeof toJSON === 'function') return canonical(toJSON.call(value));
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * SHA-256 of the operation and the request, with object keys in order, so a
 * retry that orders its JSON differently is still the same request and a
 * different request never is (API design 14.2 rule 5).
 */
export function fingerprintOf(operation: string, request: unknown): Buffer {
  return createHash('sha256').update(canonical({ operation, request })).digest();
}

/**
 * Only results a client must not repeat are stored: success answers and
 * refusals of the request's meaning (409 and 422), never a 400, 401, 403, 429 or
 * 5xx, which can change once the cause is fixed. The key's own refusals are
 * not stored either, nor a refusal that says to try again (`retryAfterSeconds`,
 * such as RESOURCE_BUSY): API design 14.4 retries it with the same key.
 */
export function isStorableRefusal(error: unknown): error is AppException {
  return (
    error instanceof AppException &&
    (error.status === HttpStatus.CONFLICT || error.status === HttpStatus.UNPROCESSABLE_ENTITY) &&
    !error.code.startsWith('IDEMPOTENCY_') &&
    error.options.retryAfterSeconds === undefined
  );
}
