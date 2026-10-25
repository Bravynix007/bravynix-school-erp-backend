import { generateOtpCode, OtpHasher } from './otp-hasher.js';

const SECRET = 'unit-test-secret-not-used-anywhere-0123456789';

describe('OtpHasher', () => {
  const hasher = new OtpHasher(SECRET);

  it('gives 32 bytes, the same for the same email in any case', () => {
    expect(hasher.email('Asha@Example.com')).toHaveLength(32);
    expect(hasher.email('Asha@Example.com').equals(hasher.email('asha@example.com'))).toBe(true);
  });

  it('keys by secret: another secret gives another hash', () => {
    const other = new OtpHasher('another-unit-test-secret-0123456789abcdef');
    expect(other.email('a@x.test').equals(hasher.email('a@x.test'))).toBe(false);
  });

  it('keeps emails and codes apart, so one can never stand for the other', () => {
    expect(hasher.email('123456').equals(hasher.code('', '123456'))).toBe(false);
    expect(hasher.email('a@x.test').equals(hasher.code('a@x.test', ''))).toBe(false);
  });

  it('binds a code to its email', () => {
    const stored = hasher.code('a@x.test', '123456');
    expect(hasher.matches(stored, 'a@x.test', '123456')).toBe(true);
    expect(hasher.matches(stored, 'A@X.test', '123456')).toBe(true);
    expect(hasher.matches(stored, 'b@x.test', '123456')).toBe(false);
    expect(hasher.matches(stored, 'a@x.test', '123457')).toBe(false);
  });

  it('rejects a stored value of the wrong length without throwing', () => {
    expect(hasher.matches(Buffer.alloc(5), 'a@x.test', '123456')).toBe(false);
  });

  it('makes a random key per process when no secret is set, so codes do not survive a restart', () => {
    const a = new OtpHasher(undefined);
    const b = new OtpHasher(undefined);
    expect(a.email('a@x.test').equals(b.email('a@x.test'))).toBe(false);
  });
});

describe('generateOtpCode', () => {
  it('is always six digits, leading zeros kept', () => {
    for (let i = 0; i < 5000; i += 1) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });

  it('is not constant', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateOtpCode()));
    expect(codes.size).toBeGreaterThan(40);
  });
});
