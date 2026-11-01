import { AppException } from '../../common/http/app-exception.js';
import {
  dueAmounts,
  fromCents,
  PAYMENT_MODES,
  rateAtPeriodStart,
  requireDue,
  requireNotes,
  requirePaidByToday,
  requirePeriod,
  rupees,
  toCents,
} from './due.rules.js';

function refusal(work: () => unknown): AppException {
  try {
    work();
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

const fields = (error: AppException) => error.options.errors?.map((e) => [e.field, e.code]);

describe('toCents and fromCents', () => {
  it.each([
    ['0.00', 0n],
    ['1234.50', 123450n],
    ['-500.00', -50000n],
    ['99999999.99', 9999999999n],
  ])('reads %s as %s and writes it back', (text, cents) => {
    expect(toCents(text)).toBe(cents);
    expect(fromCents(cents)).toBe(text);
  });

  it('pads the paise to two digits', () => {
    expect(fromCents(5n)).toBe('0.05');
    expect(fromCents(-5n)).toBe('-0.05');
  });
});

describe('dueAmounts', () => {
  it('multiplies the count by the rate, exactly, and adds the signed adjustment', () => {
    expect(dueAmounts(300, '65.00', '0.00')).toEqual({
      baseAmount: '19500.00',
      totalAmount: '19500.00',
    });
    expect(dueAmounts(3, '0.10', '-0.05')).toEqual({ baseAmount: '0.30', totalAmount: '0.25' });
    expect(dueAmounts(10, '45.50', '100.00')).toEqual({
      baseAmount: '455.00',
      totalAmount: '555.00',
    });
  });

  it('allows a free due, and a total of exactly zero', () => {
    expect(dueAmounts(0, '50.00', '0.00').totalAmount).toBe('0.00');
    expect(dueAmounts(10, '50.00', '-500.00').totalAmount).toBe('0.00');
  });

  it('refuses a total below zero with 422 TOTAL_NEGATIVE on the adjustment', () => {
    const error = refusal(() => dueAmounts(10, '50.00', '-500.01'));
    expect([error.status, error.code]).toEqual([422, 'TOTAL_NEGATIVE']);
    expect(fields(error)).toEqual([['adjustmentAmount', 'TOTAL_NEGATIVE']]);
  });

  it('refuses amounts the column cannot hold with 400 on the field that made them too large', () => {
    const base = refusal(() => dueAmounts(1_000_000, '99999999.99', '0.00'));
    expect([base.status, fields(base)]).toEqual([400, [['studentCount', 'OUT_OF_RANGE']]]);
    const total = refusal(() => dueAmounts(1_000_000, '9999.99', '99999999.99'));
    expect([total.status, fields(total)]).toEqual([400, [['adjustmentAmount', 'OUT_OF_RANGE']]]);
  });
});

describe('requireNotes', () => {
  const ok = {
    studentCount: 0,
    studentCountAuto: 0,
    studentCountNote: null,
    adjustmentAmount: '0.00',
    adjustmentNote: null,
  };

  it('asks for nothing when the count is the automatic one and there is no adjustment', () => {
    expect(() => requireNotes(ok)).not.toThrow();
  });

  it('asks for no note when a note is given anyway', () => {
    expect(() =>
      requireNotes({
        ...ok,
        studentCount: 5,
        studentCountNote: 'Register',
        adjustmentAmount: '1.00',
        adjustmentNote: 'Late',
      }),
    ).not.toThrow();
  });

  it('asks for a note on a changed count and on a non-zero adjustment, naming each field', () => {
    const count = refusal(() => requireNotes({ ...ok, studentCount: 5 }));
    expect([count.status, count.code]).toEqual([422, 'NOTE_REQUIRED']);
    expect(fields(count)).toEqual([['studentCountNote', 'NOTE_REQUIRED']]);
    const adjustment = refusal(() => requireNotes({ ...ok, adjustmentAmount: '-0.01' }));
    expect(fields(adjustment)).toEqual([['adjustmentNote', 'NOTE_REQUIRED']]);
    const both = refusal(() => requireNotes({ ...ok, studentCount: 5, adjustmentAmount: '5.00' }));
    expect(fields(both)).toEqual([
      ['studentCountNote', 'NOTE_REQUIRED'],
      ['adjustmentNote', 'NOTE_REQUIRED'],
    ]);
  });
});

describe('requirePeriod', () => {
  it('takes a period of one day or more and refuses an end before the start', () => {
    expect(() => requirePeriod('2026-04-01', '2026-04-01')).not.toThrow();
    expect(() => requirePeriod('2026-04-01', '2027-03-31')).not.toThrow();
    const error = refusal(() => requirePeriod('2026-04-02', '2026-04-01'));
    expect([error.status, fields(error)]).toEqual([400, [['periodEndDate', 'OUT_OF_RANGE']]]);
  });
});

describe('rateAtPeriodStart', () => {
  const rates = [
    { id: 'april', effective_from_date: '2026-04-01' },
    { id: 'october', effective_from_date: '2026-10-01' },
  ];

  it('takes the rate in force on the first day of the period, not the last', () => {
    expect(rateAtPeriodStart(rates, '2026-04-01').id).toBe('april');
    expect(rateAtPeriodStart(rates, '2026-09-30').id).toBe('april');
    expect(rateAtPeriodStart(rates, '2026-10-01').id).toBe('october');
  });

  it('is 422 NO_RATE_IN_FORCE on the start date when the first rate starts later', () => {
    const error = refusal(() => rateAtPeriodStart(rates, '2026-03-31'));
    expect([error.status, error.code]).toEqual([422, 'NO_RATE_IN_FORCE']);
    expect(fields(error)).toEqual([['periodStartDate', 'NO_RATE_IN_FORCE']]);
    expect(refusal(() => rateAtPeriodStart([], '2026-04-01')).code).toBe('NO_RATE_IN_FORCE');
  });
});

describe('rupees', () => {
  it.each([
    ['0.00', '₹0.00'],
    ['999.50', '₹999.50'],
    ['1000.00', '₹1,000.00'],
    ['100000.00', '₹1,00,000.00'],
    ['1234567.50', '₹12,34,567.50'],
  ])('writes %s as %s', (amount, text) => {
    expect(rupees(amount)).toBe(text);
  });
});

describe('requireDue', () => {
  it('lets a due that is still Due through', () => {
    expect(() => requireDue(1)).not.toThrow();
  });

  it.each([0, 2])('refuses status %i, which is final, with 409 INVALID_STATE', (status) => {
    const error = refusal(() => requireDue(status));
    expect([error.status, error.code]).toEqual([409, 'INVALID_STATE']);
  });
});

describe('requirePaidByToday', () => {
  it('takes today and any day before it', () => {
    expect(() => requirePaidByToday('2026-11-01', '2026-11-01')).not.toThrow();
    expect(() => requirePaidByToday('2026-05-10', '2026-11-01')).not.toThrow();
  });

  it('refuses a day to come with 400 OUT_OF_RANGE on paidDate', () => {
    const error = refusal(() => requirePaidByToday('2026-11-02', '2026-11-01'));
    expect(error.status).toBe(400);
    expect(fields(error)).toEqual([['paidDate', 'OUT_OF_RANGE']]);
  });
});

describe('PAYMENT_MODES', () => {
  it('are cash, bank transfer, UPI and cheque (PRD 11.4)', () => {
    expect(PAYMENT_MODES).toEqual([1, 2, 3, 4]);
  });
});
