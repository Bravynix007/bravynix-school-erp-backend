import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time codes (RFC 6238 over RFC 4226): HMAC-SHA1, 6 digits,
 * 30-second steps, the parameters every authenticator app defaults to. Written
 * here rather than imported because it is a page of code with published test
 * vectors, and it is the one place a second factor is checked.
 */
const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
/** Steps either side of now that are accepted, for a phone clock a few seconds off. */
const WINDOW_STEPS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The code for one step. */
export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The step whose code `submitted` is, among the current one and its neighbours,
 * or null. A step at or before `lastUsedStep` is never accepted, so a code
 * cannot be used twice, nor an older one after a newer. Every step is compared,
 * whatever the first comparison says, so the time taken does not show which
 * step matched.
 */
export function matchTotp(
  secret: Buffer,
  submitted: string,
  now: Date,
  lastUsedStep: number | null,
): number | null {
  const given = Buffer.from(submitted, 'utf8');
  const current = stepAt(now);
  let matched: number | null = null;
  for (let step = current - WINDOW_STEPS; step <= current + WINDOW_STEPS; step++) {
    const expected = Buffer.from(totpAt(secret, step), 'utf8');
    const equal = given.length === expected.length && timingSafeEqual(given, expected);
    if (equal && matched === null && (lastUsedStep === null || step > lastUsedStep)) {
      matched = step;
    }
  }
  return matched;
}

/** The `otpauth://` link an authenticator app scans as a QR code. */
export function setupUri(secret: Buffer, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
