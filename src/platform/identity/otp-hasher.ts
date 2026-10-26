import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Keyed hashes for the login flow (SDD 13.2). A plain hash of a 6-digit code
 * can be reversed by trying a million values, so codes are stored as an HMAC
 * with a server secret; emails are keyed the same way so the table never holds
 * an address. The two uses are domain-separated, so a value for one can never
 * stand for the other.
 */
export class OtpHasher {
  private readonly key: Buffer;

  constructor(secret: string | undefined) {
    this.key = secret ? Buffer.from(secret, 'utf8') : randomBytes(32);
  }

  /** 32 bytes; the same lower-cased email always gives the same value. */
  email(email: string): Buffer {
    return createHmac('sha256', this.key).update(`email:${email.toLowerCase()}`).digest();
  }

  /** 32 bytes, bound to the email, so a code only ever matches its own request. */
  code(email: string, code: string): Buffer {
    return createHmac('sha256', this.key).update(`otp:${email.toLowerCase()}:${code}`).digest();
  }

  matches(expected: Buffer, email: string, code: string): boolean {
    const actual = this.code(email, code);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

/** Six digits from a secure random generator, leading zeros kept. */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
