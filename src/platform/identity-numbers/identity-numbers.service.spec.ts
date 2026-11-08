import { randomBytes } from 'node:crypto';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import { SecretBox } from '../crypto/index.js';
import { IdentityNumbers, type IdentitySlot } from './identity-numbers.service.js';

const ENCRYPTION = randomBytes(32).toString('base64');
const HMAC = randomBytes(32);
const slot: IdentitySlot = { table: 'staff_identities', rowId: 'row-1' };

const build = (hmac = HMAC) =>
  new IdentityNumbers(
    new SecretBox(ENCRYPTION, 'IDENTITY_ENCRYPTION_KEY'),
    hmac,
    {} as AuditService,
    new FixedClock(),
  );

describe('IdentityNumbers.protect', () => {
  it('keeps the last four digits, a 32-byte keyed hash and a ciphertext that is not the number', () => {
    const protectedNumber = build().protect('2345 6789 0124', slot);
    expect(protectedNumber.last4).toBe('0124');
    expect(protectedNumber.hmac).toHaveLength(32);
    expect(protectedNumber.keyVersion).toBe(1);
    expect(protectedNumber.ciphertext.includes(Buffer.from('234567890124'))).toBe(false);
  });

  it('gives the same hash for the same number however it is typed, and another for another number', () => {
    const numbers = build();
    const a = numbers.protect('2345 6789 0124', slot).hmac;
    expect(numbers.protect('234567890124', { ...slot, rowId: 'row-2' }).hmac.equals(a)).toBe(true);
    expect(numbers.protect('987654321096', slot).hmac.equals(a)).toBe(false);
    expect(numbers.hashOf('234567890124').equals(a)).toBe(true);
  });

  it('keys the hash: another key gives another hash, so it cannot be rebuilt by trying every number', () => {
    const a = build().protect('234567890124', slot).hmac;
    const b = build(randomBytes(32)).protect('234567890124', slot).hmac;
    expect(a.equals(b)).toBe(false);
  });

  it('seals the same number differently each time', () => {
    const numbers = build();
    const a = numbers.protect('234567890124', slot).ciphertext;
    const b = numbers.protect('234567890124', slot).ciphertext;
    expect(a.equals(b)).toBe(false);
  });

  it('refuses a number that is not valid with 422 INVALID_AADHAAR', () => {
    for (const bad of ['', '234567890125', '12345', 'abcdefghijkl']) {
      expect(() => build().protect(bad, slot)).toThrow(
        expect.objectContaining({ status: 422, code: 'INVALID_AADHAAR' }) as Error,
      );
    }
  });
});
