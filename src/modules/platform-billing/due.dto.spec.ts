import { body, problems } from '../../../test/support/dto-validation.js';
import {
  CancelDueDto,
  DueQuoteQueryDto,
  ListDuesQueryDto,
  MarkDuePaidDto,
  RaiseDueDto,
  UpdateDueDto,
} from './due.dto.js';

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

describe('UpdateDueDto', () => {
  it('needs the version and nothing else, and takes any of the fields of a raise', async () => {
    for (const value of [
      { version: 1 },
      { version: 3, studentCount: 0, dueDate: '2026-05-15' },
      {
        version: 2,
        periodStartDate: '2026-10-01',
        periodEndDate: '2027-03-31',
        studentCount: 310,
        studentCountNote: 'Recount',
        adjustmentAmount: '-500.00',
        adjustmentNote: 'Discount',
      },
      { version: 2, studentCountNote: null, adjustmentNote: null, dueDate: null },
    ]) {
      expect(await problems(body(UpdateDueDto, value))).toEqual([]);
    }
  });

  it.each([
    [{}, 'version', 'INVALID_TYPE'],
    [{ version: '1' }, 'version', 'INVALID_TYPE'],
    [{ version: 1, periodStartDate: null }, 'periodStartDate', 'INVALID_TYPE'],
    [{ version: 1, periodEndDate: '2027-02-30' }, 'periodEndDate', 'INVALID_FORMAT'],
    [{ version: 1, studentCount: null }, 'studentCount', 'INVALID_TYPE'],
    [{ version: 1, studentCount: -1 }, 'studentCount', 'OUT_OF_RANGE'],
    [{ version: 1, studentCountNote: '' }, 'studentCountNote', 'TOO_SHORT'],
    [{ version: 1, adjustmentAmount: null }, 'adjustmentAmount', 'INVALID_TYPE'],
    [{ version: 1, adjustmentAmount: '5' }, 'adjustmentAmount', 'INVALID_FORMAT'],
    [{ version: 1, adjustmentNote: 'n'.repeat(501) }, 'adjustmentNote', 'TOO_LONG'],
    [{ version: 1, dueDate: '15-05-2026' }, 'dueDate', 'INVALID_FORMAT'],
    [
      { version: 1, institutionId: '0190a000-0000-7000-8000-000000000001' },
      'institutionId',
      'FIELD_NOT_ALLOWED',
    ],
    [{ version: 1, totalAmount: '1.00' }, 'totalAmount', 'FIELD_NOT_ALLOWED'],
    [{ version: 1, dueStatus: 2 }, 'dueStatus', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(UpdateDueDto, value))).toContainEqual({ field, code });
  });
});

describe('MarkDuePaidDto', () => {
  const paid = { version: 1, paidDate: '2026-05-10', paymentMode: 2 };

  it('takes the date and mode, with or without a reference', async () => {
    for (const value of [
      paid,
      { ...paid, paymentMode: 1 },
      { ...paid, paymentMode: 4, paymentReference: 'Cheque 000231' },
      { ...paid, paymentReference: null },
      { ...paid, paymentReference: 'r'.repeat(100) },
    ]) {
      expect(await problems(body(MarkDuePaidDto, value))).toEqual([]);
    }
  });

  it.each([
    [{ ...paid, version: undefined }, 'version', 'INVALID_TYPE'],
    [{ ...paid, paidDate: undefined }, 'paidDate', 'INVALID_TYPE'],
    [{ ...paid, paidDate: '2026-13-01' }, 'paidDate', 'INVALID_FORMAT'],
    [{ ...paid, paymentMode: undefined }, 'paymentMode', 'INVALID_CODE'],
    [{ ...paid, paymentMode: 0 }, 'paymentMode', 'INVALID_CODE'],
    [{ ...paid, paymentMode: 5 }, 'paymentMode', 'INVALID_CODE'],
    [{ ...paid, paymentMode: '2' }, 'paymentMode', 'INVALID_CODE'],
    [{ ...paid, paymentReference: '' }, 'paymentReference', 'TOO_SHORT'],
    [{ ...paid, paymentReference: 'r'.repeat(101) }, 'paymentReference', 'TOO_LONG'],
    [{ ...paid, dueStatus: 2 }, 'dueStatus', 'FIELD_NOT_ALLOWED'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(MarkDuePaidDto, value))).toContainEqual({ field, code });
  });
});

describe('CancelDueDto', () => {
  it('needs a reason of 5 to 500 characters', async () => {
    for (const reason of ['Wrong', 'Raised twice', 'r'.repeat(500)]) {
      expect(await problems(body(CancelDueDto, { version: 1, reason }))).toEqual([]);
    }
  });

  it.each([
    [{ version: 1 }, 'reason', 'INVALID_TYPE'],
    [{ version: 1, reason: 'Oops' }, 'reason', 'TOO_SHORT'],
    [{ version: 1, reason: 'r'.repeat(501) }, 'reason', 'TOO_LONG'],
    [{ reason: 'Raised twice' }, 'version', 'INVALID_TYPE'],
  ])('refuses %j', async (value, field, code) => {
    expect(await problems(body(CancelDueDto, value))).toContainEqual({ field, code });
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
