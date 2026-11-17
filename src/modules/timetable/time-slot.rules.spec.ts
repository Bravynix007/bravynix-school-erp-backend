import { AppException } from '../../common/http/app-exception.js';
import { clockOf, requireTimes, translateTimeSlotError } from './time-slot.rules.js';

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

describe('translateTimeSlotError', () => {
  it('turns a number already used by an active period into DUPLICATE on periodNo', () => {
    const error = translateTimeSlotError({
      code: '23505',
      constraint: 'uq_time_slots_year_period',
    }) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe('DUPLICATE');
    expect(error.options.errors?.[0]).toMatchObject({ field: 'periodNo' });
  });

  it.each([
    { code: '23P01', constraint: 'ex_time_slots_no_overlap' },
    { code: '23505', constraint: 'uq_time_slots_year_start' },
  ])('turns %j into TIME_SLOT_OVERLAP', (violation) => {
    const error = translateTimeSlotError(violation) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe('TIME_SLOT_OVERLAP');
    expect(error.options.errors?.[0]).toMatchObject({ field: 'startTime' });
  });

  it('leaves any other error alone', () => {
    const other = new Error('boom');
    expect(translateTimeSlotError(other)).toBe(other);
  });
});
