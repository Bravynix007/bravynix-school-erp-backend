import { randomBytes } from 'node:crypto';
import { SecretBox } from './secret-box.js';

const key = randomBytes(32).toString('base64');
const secret = Buffer.from('12345678901234567890');

/** Node's message when the tag does not match. */
const AUTH_FAILED = 'unable to authenticate data';

describe('SecretBox', () => {
  it('opens what it sealed', () => {
    const box = new SecretBox(key);
    expect(box.open(box.seal(secret, 'user-1'), 'user-1')).toEqual(secret);
  });

  it('seals the same secret differently each time, and does not contain it', () => {
    const box = new SecretBox(key);
    const a = box.seal(secret, 'user-1');
    const b = box.seal(secret, 'user-1');
    expect(a.equals(b)).toBe(false);
    expect(a.includes(secret)).toBe(false);
  });

  it('refuses a value that was changed anywhere', () => {
    const box = new SecretBox(key);
    const sealed = box.seal(secret, 'user-1');
    for (const index of [0, 12, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      expect(() => box.open(tampered, 'user-1')).toThrow(AUTH_FAILED);
    }
  });

  it('refuses a value copied to another person, or opened with another key', () => {
    const box = new SecretBox(key);
    const sealed = box.seal(secret, 'user-1');
    expect(() => box.open(sealed, 'user-2')).toThrow(AUTH_FAILED);
    expect(() => new SecretBox(randomBytes(32).toString('base64')).open(sealed, 'user-1')).toThrow(
      AUTH_FAILED,
    );
  });

  it('refuses a value too short to hold the parts', () => {
    expect(() => new SecretBox(key).open(Buffer.alloc(20), 'user-1')).toThrow(/too short/);
  });

  it('refuses a key of the wrong size, and makes its own when none is given', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    const box = new SecretBox(undefined);
    expect(box.open(box.seal(secret, 'x'), 'x')).toEqual(secret);
  });
});
