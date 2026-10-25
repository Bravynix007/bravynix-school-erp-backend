/**
 * Before and after values for an audit entry (DDD 9.12): changed fields only,
 * and nothing secret. The caller should already pass only what it means to
 * record; this is the safety net that keeps a careless call from putting a
 * code, a token or a full ID number into a table nobody can edit.
 */

export type AuditValues = Record<string, unknown>;

/** Largest serialised before or after value, so one entry cannot swamp the table. */
export const MAX_AUDIT_VALUES_BYTES = 32 * 1024;

/**
 * OTPs, tokens, passwords, hashes and keys never appear (DDD 9.12). Matched on
 * whole name parts, so `tokens_used` stays but `tokens`, `hashes` and
 * `recovery_codes` go: a plural counts only as the last part.
 */
const NEVER_LOGGED = new RegExp(
  '(^|_)(' +
    [
      'otp',
      'totp',
      'password',
      'passcode',
      'passwd',
      'pwd',
      'mpin',
      'secret',
      'token',
      'hash',
      'ciphertext',
      'nonce',
      'salt',
      'jwt',
      'cookie',
      'authorization',
      'credential',
      'cvv',
      'api_?key',
      'private_key',
      'access_key',
      'recovery_code',
      'backup_code',
    ].join('|') +
    ')(_|\\d|e?s$|$)|(^|_)m?pins?$',
);

/**
 * Aadhaar and bank values appear only as "changed" with the last 4 digits.
 * Patterns, not a list, because the same field is spelled many ways
 * (`aadhaarNo`, `aadhar_number`, `account_no`).
 */
const MASKED = [
  /(^|_)aadhaa?r(_(no|num|number|id))?$/,
  /(^|_)(bank_)?(account|acct)(_(no|num|number))?$/,
  /(^|_)ac_(no|num|number)$/,
];

const LAST4_SUFFIX = /_last4$/;

/**
 * A 12-digit Aadhaar shape, with or without separators, inside any text. Not
 * part of a longer word or dash-joined token, so the 12-digit last group of a
 * UUID is left alone (about 1 UUID in 90 has one). The cost: "ID-123456789012"
 * is not caught here; the key patterns catch named fields.
 */
const AADHAAR_SHAPE = /(?<![\w-])(\d{4})[ -]?(\d{4})[ -]?(\d{4})(?![\w-])/g;

function snake(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function last4(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Whatever the key, an Aadhaar-shaped number in text is masked (a safe failure for a 12-digit phone number). */
function scrubText(text: string): string {
  return text.replace(AADHAAR_SHAPE, (_match, _a, _b, c: string) => `XXXX XXXX ${c}`);
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return redactValues(value as AuditValues);
  }
  return value;
}

function redactValue(key: string, value: unknown): { keep: boolean; value?: unknown } {
  const name = snake(key);
  if (LAST4_SUFFIX.test(name)) return { keep: true, value: redactDeep(value) };
  if (NEVER_LOGGED.test(name)) return { keep: false };
  if (MASKED.some((pattern) => pattern.test(name))) {
    return { keep: true, value: { changed: true, last4: last4(value) } };
  }
  return { keep: true, value: redactDeep(value) };
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

/** JSON with object keys in order, so the same content in another order compares equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([x], [y]) => x.localeCompare(y)))
      : inner,
  );
}

function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
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

/** Half of a UTF-16 pair with no other half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Serialises for the jsonb column and refuses a value that is too large. */
export function serializeValues(values: AuditValues | null): string | null {
  if (values === null) return null;
  // jsonb cannot hold U+0000 or a lone surrogate; either would fail the change
  // being recorded, so drop the first and replace the second.
  const text = JSON.stringify(values, (_key, value: unknown) =>
    typeof value === 'string'
      ? value.replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD')
      : value,
  );
  if (Buffer.byteLength(text, 'utf8') > MAX_AUDIT_VALUES_BYTES) {
    throw new Error(
      `Audit values are over ${MAX_AUDIT_VALUES_BYTES} bytes; record the changed fields only`,
    );
  }
  return text;
}
