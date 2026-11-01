import { body, problems } from '../../../test/support/dto-validation.js';
import { SetPriceRateDto } from './price-rate.dto.js';

const valid = { ratePerStudentAmount: '50.00', effectiveFromDate: '2026-04-01' };

describe('SetPriceRateDto', () => {
  it('takes a two-decimal rate, a calendar date and an optional note', async () => {
    for (const value of [
      valid,
      { ...valid, ratePerStudentAmount: '0.00' },
      { ...valid, ratePerStudentAmount: '99999999.99' },
      { ...valid, effectiveFromDate: '2024-02-29', note: 'Agreed for 2026-27' },
      { ...valid, note: 'n'.repeat(500) },
      { ...valid, note: null },
    ]) {
      expect(await problems(body(SetPriceRateDto, value))).toEqual([]);
    }
  });

  it.each([
    [{ effectiveFromDate: valid.effectiveFromDate }, 'ratePerStudentAmount', 'INVALID_TYPE'],
    [{ ...valid, ratePerStudentAmount: 50 }, 'ratePerStudentAmount', 'INVALID_TYPE'],
    [{ ...valid, ratePerStudentAmount: '50' }, 'ratePerStudentAmount', 'INVALID_FORMAT'],
    [{ ...valid, ratePerStudentAmount: '50.5' }, 'ratePerStudentAmount', 'INVALID_FORMAT'],
    [{ ...valid, ratePerStudentAmount: '50.001' }, 'ratePerStudentAmount', 'INVALID_FORMAT'],
    [{ ...valid, ratePerStudentAmount: '-1.00' }, 'ratePerStudentAmount', 'INVALID_FORMAT'],
    [{ ...valid, ratePerStudentAmount: '100000000.00' }, 'ratePerStudentAmount', 'INVALID_FORMAT'],
    [{ ratePerStudentAmount: valid.ratePerStudentAmount }, 'effectiveFromDate', 'INVALID_TYPE'],
    [{ ...valid, effectiveFromDate: '2026-02-30' }, 'effectiveFromDate', 'INVALID_FORMAT'],
    [{ ...valid, effectiveFromDate: '2026-4-1' }, 'effectiveFromDate', 'INVALID_FORMAT'],
    [
      { ...valid, effectiveFromDate: '2026-04-01T00:00:00Z' },
      'effectiveFromDate',
      'INVALID_FORMAT',
    ],
    [{ ...valid, effectiveFromDate: 20260401 }, 'effectiveFromDate', 'INVALID_TYPE'],
    [{ ...valid, note: '' }, 'note', 'TOO_SHORT'],
    [{ ...valid, note: 'n'.repeat(501) }, 'note', 'TOO_LONG'],
    [{ ...valid, note: 5 }, 'note', 'INVALID_TYPE'],
    [{ ...valid, institutionId: 'x' }, 'institutionId', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(SetPriceRateDto, value))).toContainEqual({ field, code });
  });
});
