import { AppException } from '../../common/http/app-exception.js';
import { decimalOf, requireRange, translateGradeBandError } from './grade-band.rules.js';

function refusal(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Expected a refusal');
}

describe('requireRange', () => {
  it('accepts a range that runs upwards, and a range of one value', () => {
    expect(() => requireRange(0, 100)).not.toThrow();
    expect(() => requireRange(90.99, 90.99)).not.toThrow();
  });

  it('refuses a minimum above the maximum, on maxPercentage', () => {
    const error = refusal(() => requireRange(91, 90.99));
    expect(error.status).toBe(400);
    expect(error.options.errors).toEqual([
      expect.objectContaining({ field: 'maxPercentage', code: 'OUT_OF_RANGE' }),
    ]);
  });
});

describe('decimalOf', () => {
  it('reads the database’s exact decimals as numbers, and keeps an empty one empty', () => {
    expect(decimalOf('90.99')).toBe(90.99);
    expect(decimalOf('100.00')).toBe(100);
    expect(decimalOf('0.00')).toBe(0);
    expect(decimalOf(null)).toBeNull();
  });
});

describe('translateGradeBandError', () => {
  it('turns a name already used by an active band into DUPLICATE on name', () => {
    const error = translateGradeBandError({
      code: '23505',
      constraint: 'uq_grade_bands_institution_name',
    }) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe('DUPLICATE');
    expect(error.options.errors?.[0]).toMatchObject({ field: 'name' });
  });

  it('turns the overlap exclusion into GRADE_BAND_OVERLAP on minPercentage', () => {
    const error = translateGradeBandError({
      code: '23P01',
      constraint: 'ex_grade_bands_no_overlap',
    }) as AppException;
    expect(error.status).toBe(409);
    expect(error.code).toBe('GRADE_BAND_OVERLAP');
    expect(error.options.errors?.[0]).toMatchObject({
      field: 'minPercentage',
      code: 'GRADE_BAND_OVERLAP',
    });
  });

  it('leaves any other error alone', () => {
    const other = new Error('boom');
    expect(translateGradeBandError(other)).toBe(other);
    const elsewhere = { code: '23P01', constraint: 'ex_time_slots_no_overlap' };
    expect(translateGradeBandError(elsewhere)).toBe(elsewhere);
  });
});
