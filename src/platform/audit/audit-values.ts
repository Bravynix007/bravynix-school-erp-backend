/**
 * Before and after values for an audit entry (DDD 9.12): changed fields only,
 * and nothing secret. The caller should already pass only what it means to
 * record; this is the safety net that keeps a careless call from putting a
 * code, a token or a full ID number into a table nobody can edit.
 */

export type AuditValues = Record<string, unknown>;

/** Largest serialised before or after value, so one entry cannot swamp the table. */
export const MAX_AUDIT_VALUES_BYTES = 32 * 1024;

/** OTPs, tokens, passwords, hashes and keys never appear (DDD 9.12). */
const NEVER_LOGGED =
  /(^|_)(otp|password|passcode|secret|token|hash|ciphertext|nonce|totp|api_key|private_key|access_key)(_|$)/;

/** Aadhaar and bank values appear only as "changed" with the last 4 digits. */
const MASKED = new Set(['aadhaar', 'aadhaar_number', 'bank_account', 'bank_account_number']);

const LAST4_SUFFIX = /_last4$/;

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function last4(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function redactValue(key: string, value: unknown): { keep: boolean; value?: unknown } {
  const name = snake(key);
  if (LAST4_SUFFIX.test(name)) return { keep: true, value };
  if (NEVER_LOGGED.test(name)) return { keep: false };
  if (MASKED.has(name)) return { keep: true, value: { changed: true, last4: last4(value) } };
  if (Array.isArray(value)) return { keep: true, value: value.map((item) => redactDeep(item)) };
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return { keep: true, value: redactValues(value as AuditValues) };
  }
  return { keep: true, value };
}

function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return redactValues(value as AuditValues);
  }
  return value;
}

/** Removes secrets and masks ID numbers, at every depth. */
export function redactValues(values: AuditValues): AuditValues {
  const out: AuditValues = {};
  for (const [key, value] of Object.entries(values)) {
    const result = redactValue(key, value);
    if (result.keep) out[key] = result.value;
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The fields that differ between a record before and after a change.
 * `before` null is a create (every field is new); `after` null is a delete.
 * Unchanged fields are left out, so an edit shows what the person changed.
 */
export function changedFields(
  before: AuditValues | null | undefined,
  after: AuditValues | null | undefined,
): { old: AuditValues | null; new: AuditValues | null } {
  if (!before && !after) return { old: null, new: null };
  if (!before) return { old: null, new: redactValues(after!) };
  if (!after) return { old: redactValues(before), new: null };
  const oldValues: AuditValues = {};
  const newValues: AuditValues = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    if (key in before) oldValues[key] = before[key];
    if (key in after) newValues[key] = after[key];
  }
  return { old: redactValues(oldValues), new: redactValues(newValues) };
}

/** Serialises for the jsonb column and refuses a value that is too large. */
export function serializeValues(values: AuditValues | null): string | null {
  if (values === null) return null;
  const text = JSON.stringify(values);
  if (Buffer.byteLength(text, 'utf8') > MAX_AUDIT_VALUES_BYTES) {
    throw new Error(
      `Audit values are over ${MAX_AUDIT_VALUES_BYTES} bytes; record the changed fields only`,
    );
  }
  return text;
}
