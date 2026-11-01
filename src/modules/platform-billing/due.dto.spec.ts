import { body, problems } from '../../../test/support/dto-validation.js';
import { DueQuoteQueryDto, ListDuesQueryDto, RaiseDueDto } from './due.dto.js';

const institutionId = '0190a000-0000-7000-8000-000000000001';
const valid = {
  institutionId,
  periodStartDate: '2026-04-01',
  periodEndDate: '2027-03-31',
  studentCount: 300,
};

describe('RaiseDueDto', () => {
  it('takes the least a due needs, and every optional field', async () => {
    for (const value of [
      valid,
      { ...valid, studentCount: 0 },
      { ...valid, studentCount: 1_000_000 },
      {
        ...valid,
        studentCountNote: 'From the register',
        adjustmentAmount: '-500.00',
        adjustmentNote: 'Discount',
      },
      { ...valid, adjustmentAmount: '99999999.99', dueDate: '2026-05-15' },
      { ...valid, studentCountNote: null, adjustmentNote: null, dueDate: null },
    ]) {
      expect(await problems(body(RaiseDueDto, value))).toEqual([]);
    }
  });

  it.each([
    [{ ...valid, institutionId: undefined }, 'institutionId', 'INVALID_FORMAT'],
    [{ ...valid, institutionId: 'x' }, 'institutionId', 'INVALID_FORMAT'],
    [{ ...valid, periodStartDate: undefined }, 'periodStartDate', 'INVALID_TYPE'],
    [{ ...valid, periodStartDate: '2026-02-30' }, 'periodStartDate', 'INVALID_FORMAT'],
    [{ ...valid, periodEndDate: '2027-3-31' }, 'periodEndDate', 'INVALID_FORMAT'],
    [{ ...valid, studentCount: undefined }, 'studentCount', 'INVALID_TYPE'],
    [{ ...valid, studentCount: '300' }, 'studentCount', 'INVALID_TYPE'],
    [{ ...valid, studentCount: 1.5 }, 'studentCount', 'INVALID_TYPE'],
    [{ ...valid, studentCount: -1 }, 'studentCount', 'OUT_OF_RANGE'],
    [{ ...valid, studentCount: 1_000_001 }, 'studentCount', 'OUT_OF_RANGE'],
    [{ ...valid, studentCountNote: '' }, 'studentCountNote', 'TOO_SHORT'],
    [{ ...valid, studentCountNote: 'n'.repeat(501) }, 'studentCountNote', 'TOO_LONG'],
    [{ ...valid, adjustmentAmount: 5 }, 'adjustmentAmount', 'INVALID_TYPE'],
    [{ ...valid, adjustmentAmount: '5' }, 'adjustmentAmount', 'INVALID_FORMAT'],
    [{ ...valid, adjustmentAmount: '5.5' }, 'adjustmentAmount', 'INVALID_FORMAT'],
    [{ ...valid, adjustmentAmount: '100000000.00' }, 'adjustmentAmount', 'INVALID_FORMAT'],
    [{ ...valid, adjustmentNote: '' }, 'adjustmentNote', 'TOO_SHORT'],
    [{ ...valid, dueDate: '15-05-2026' }, 'dueDate', 'INVALID_FORMAT'],
    [{ ...valid, invoiceNo: 'BNX/1' }, 'invoiceNo', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(RaiseDueDto, value))).toContainEqual({ field, code });
  });
});

describe('DueQuoteQueryDto', () => {
  it('needs both dates of the period', async () => {
    expect(
      await problems(
        body(DueQuoteQueryDto, { periodStartDate: '2026-04-01', periodEndDate: '2027-03-31' }),
      ),
    ).toEqual([]);
    expect(
      await problems(body(DueQuoteQueryDto, { periodStartDate: '2026-04-01' })),
    ).toContainEqual({
      field: 'periodEndDate',
      code: 'INVALID_TYPE',
    });
  });
});

describe('ListDuesQueryDto', () => {
  it('reads one status or several from the query string as numbers', async () => {
    const one = await body(ListDuesQueryDto, { dueStatus: '1' });
    expect(one.dueStatus).toEqual([1]);
    const several = await body(ListDuesQueryDto, { dueStatus: ['0', '2'], institutionId });
    expect(several.dueStatus).toEqual([0, 2]);
  });

  it.each([['3'], ['x'], ['']])('refuses the status %j', async (status) => {
    expect(await problems(body(ListDuesQueryDto, { dueStatus: status }))).toContainEqual(
      expect.objectContaining({ field: 'dueStatus' }),
    );
  });

  it('refuses a Society or Institution that is not a UUID', async () => {
    expect(await problems(body(ListDuesQueryDto, { societyId: 'x', institutionId: 'y' }))).toEqual([
      { field: 'societyId', code: 'INVALID_FORMAT' },
      { field: 'institutionId', code: 'INVALID_FORMAT' },
    ]);
  });
});
