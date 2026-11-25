import { AppException } from '../../common/http/app-exception.js';
import { translateTimeSlotError } from './time-slot.rules.js';

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
