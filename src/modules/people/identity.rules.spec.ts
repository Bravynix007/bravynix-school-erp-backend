import type { ProtectedAadhaar } from '../../platform/identity-numbers/index.js';
import { sameNumber } from './identity.rules.js';

const claim = (byte: number): ProtectedAadhaar => ({
  ciphertext: Buffer.from('sealed'),
  keyVersion: 1,
  hmac: Buffer.alloc(32, byte),
  last4: '0124',
});

describe('sameNumber', () => {
  it.each([
    ['nothing stored and nothing claimed', undefined, null, true],
    ['an emptied row and nothing claimed', { aadhaar_hmac: null }, null, true],
    ['the same hash', { aadhaar_hmac: Buffer.alloc(32, 1) }, claim(1), true],
    ['another hash', { aadhaar_hmac: Buffer.alloc(32, 1) }, claim(2), false],
    ['a number claimed and none stored', undefined, claim(1), false],
    [
      'a number stored and the claim to clear it',
      { aadhaar_hmac: Buffer.alloc(32, 1) },
      null,
      false,
    ],
  ])('for %s', (_name, stored, claimed, expected) => {
    expect(sameNumber(stored, claimed)).toBe(expected);
  });
});
