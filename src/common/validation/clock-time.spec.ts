import { AppException } from '../http/app-exception.js';
import { clockOf, requireTimes } from './clock-time.js';

function refusal(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Expected a refusal');
}

describe('requireTimes', () => {
  it('accepts an end after the start', () => {
    expect(() => requireTimes('09:00', '09:01')).not.toThrow();
    expect(() => requireTimes('00:00', '23:59')).not.toThrow();
  });

  it.each([
    ['09:00', '09:00'],
    ['09:00', '08:59'],
  ])('refuses %s to %s on endTime', (start, end) => {
    const error = refusal(() => requireTimes(start, end));
    expect(error.status).toBe(400);
    expect(error.options.errors).toEqual([
      expect.objectContaining({ field: 'endTime', code: 'OUT_OF_RANGE' }),
    ]);
  });
});

describe('clockOf', () => {
  it('drops the seconds the database adds', () => {
    expect(clockOf('09:40:00')).toBe('09:40');
    expect(clockOf('09:40')).toBe('09:40');
  });
});
