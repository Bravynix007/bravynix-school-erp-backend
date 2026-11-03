import { AppException } from '../../common/http/app-exception.js';
import { requireYearDates, translateYearError } from './academic-year.rules.js';

function refusal(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Expected a refusal');
}

describe('requireYearDates', () => {
  it('accepts an end after the start', () => {
    expect(() => requireYearDates('2026-06-01', '2026-06-02')).not.toThrow();
    expect(() => requireYearDates('2026-06-01', '2027-03-31')).not.toThrow();
  });

  it.each([
    ['2026-06-01', '2026-06-01'],
    ['2026-06-01', '2026-05-31'],
  ])('refuses %s to %s on endDate', (start, end) => {
    const error = refusal(() => requireYearDates(start, end));
    expect(error.status).toBe(400);
    expect(error.options.errors).toEqual([
      expect.objectContaining({ field: 'endDate', code: 'OUT_OF_RANGE' }),
    ]);
  });
});

describe('translateYearError', () => {
  it('turns a name already used by an active year into DUPLICATE on name', () => {
    const error = translateYearError({
      code: '23505',
      constraint: 'uq_academic_years_institution_name',
    }) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe('DUPLICATE');
    expect(error.options.errors?.[0]).toMatchObject({ field: 'name' });
  });

  it('turns an overlap into YEAR_OVERLAP', () => {
    const error = translateYearError({
      code: '23P01',
      constraint: 'ex_academic_years_no_overlap',
    }) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe('YEAR_OVERLAP');
  });

  it('leaves any other error as it is', () => {
    const other = new Error('boom');
    expect(translateYearError(other)).toBe(other);
    expect(translateYearError({ code: '23505', constraint: 'uq_something_else' })).toEqual({
      code: '23505',
      constraint: 'uq_something_else',
    });
    expect(translateYearError(undefined)).toBeUndefined();
  });
});
