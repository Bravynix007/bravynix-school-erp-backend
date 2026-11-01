import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { fingerprintOf, isStorableRefusal, parseIdempotencyKey } from './idempotency.rules.js';

const key = '00000000-0000-4000-8000-000000000001';

describe('parseIdempotencyKey', () => {
  it('takes a UUID, lower-cased and trimmed', () => {
    expect(parseIdempotencyKey(key)).toBe(key);
    expect(parseIdempotencyKey(`  ${key.toUpperCase()} `)).toBe(key);
  });

  it.each([undefined, '', '   '])('answers 400 IDEMPOTENCY_KEY_REQUIRED for %j', (raw) => {
    expect(() => parseIdempotencyKey(raw)).toThrow(
      expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }),
    );
  });

  it.each(['nope', '12345', `${key}x`, [key, key]])(
    'answers 400 VALIDATION_FAILED on the header for %j',
    (raw) => {
      expect(() => parseIdempotencyKey(raw)).toThrow(
        expect.objectContaining({
          status: 400,
          code: 'VALIDATION_FAILED',
          options: expect.objectContaining({
            errors: [expect.objectContaining({ field: 'Idempotency-Key', code: 'INVALID_FORMAT' })],
          }),
        }),
      );
    },
  );
});

describe('fingerprintOf', () => {
  it('is the same for the same request whatever order its keys come in', () => {
    const a = fingerprintOf('billing.raise_due', { a: 1, b: { c: [1, 2], d: 'x' } });
    const b = fingerprintOf('billing.raise_due', { b: { d: 'x', c: [1, 2] }, a: 1 });
    expect(a.equals(b)).toBe(true);
  });

  it('ignores a field that is not there, but not one that is null', () => {
    const base = fingerprintOf('op', { a: 1 });
    expect(base.equals(fingerprintOf('op', { a: 1, b: undefined }))).toBe(true);
    expect(base.equals(fingerprintOf('op', { a: 1, b: null }))).toBe(false);
  });

  it.each([
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, { a: '1' }],
    [{ a: [1, 2] }, { a: [2, 1] }],
    [{ a: { b: 1 } }, { a: { c: 1 } }],
  ])('differs when the request does: %j and %j', (first, second) => {
    expect(fingerprintOf('op', first).equals(fingerprintOf('op', second))).toBe(false);
  });

  it('reads a date as its ISO text, so two different dates differ and one date is stable', () => {
    const a = fingerprintOf('op', { from: new Date('2026-04-01T00:00:00Z') });
    expect(a.equals(fingerprintOf('op', { from: new Date('2026-04-01T00:00:00Z') }))).toBe(true);
    expect(a.equals(fingerprintOf('op', { from: new Date('2026-05-01T00:00:00Z') }))).toBe(false);
    expect(a.equals(fingerprintOf('op', { from: '2026-04-01T00:00:00.000Z' }))).toBe(true);
  });

  it.each([new Map([[1, 2]]), new Set([1])])(
    'refuses a Map or a Set, which would otherwise read as {}',
    (odd) => {
      expect(() => fingerprintOf('op', { odd })).toThrow(TypeError);
    },
  );

  it('reads a class instance, such as a validated body, as its own fields', () => {
    class Body {
      label = 'a';
    }
    expect(fingerprintOf('op', new Body()).equals(fingerprintOf('op', { label: 'a' }))).toBe(true);
  });

  it('differs when the operation does', () => {
    expect(fingerprintOf('one', {}).equals(fingerprintOf('two', {}))).toBe(false);
  });

  it('reads a body that is not an object too', () => {
    expect(fingerprintOf('op', null).equals(fingerprintOf('op', null))).toBe(true);
    expect(fingerprintOf('op', null).equals(fingerprintOf('op', 'x'))).toBe(false);
    expect(fingerprintOf('op', 'x').equals(fingerprintOf('op', 'y'))).toBe(false);
  });
});

const refusal = (status: HttpStatus, code = 'DUPLICATE') => new AppException(status, code);

describe('isStorableRefusal', () => {
  it('keeps 409 and 422 refusals of the request’s meaning', () => {
    expect(isStorableRefusal(refusal(HttpStatus.CONFLICT))).toBe(true);
    expect(isStorableRefusal(refusal(HttpStatus.UNPROCESSABLE_ENTITY, 'NO_RATE_IN_FORCE'))).toBe(
      true,
    );
  });

  it.each([400, 401, 403, 404, 423, 429, 500, 503])('does not keep a %i', (status) => {
    expect(isStorableRefusal(refusal(status))).toBe(false);
  });

  it('does not keep a refusal that says to try again: it is retried with the same key', () => {
    const busy = new AppException(HttpStatus.CONFLICT, 'RESOURCE_BUSY', { retryAfterSeconds: 2 });
    expect(isStorableRefusal(busy)).toBe(false);
  });

  it('does not keep the key’s own refusals, or an error that is not an AppException', () => {
    expect(isStorableRefusal(refusal(HttpStatus.CONFLICT, 'IDEMPOTENCY_IN_PROGRESS'))).toBe(false);
    expect(
      isStorableRefusal(refusal(HttpStatus.UNPROCESSABLE_ENTITY, 'IDEMPOTENCY_KEY_REUSED')),
    ).toBe(false);
    expect(isStorableRefusal(new Error('boom'))).toBe(false);
    expect(isStorableRefusal(null)).toBe(false);
  });
});
