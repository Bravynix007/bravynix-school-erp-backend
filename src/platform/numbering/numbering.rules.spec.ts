import {
  financialYearOf,
  formatNumber,
  platformInvoicePrefix,
  PLATFORM_INVOICE_WIDTH,
} from './numbering.rules.js';

describe('financialYearOf', () => {
  it.each([
    ['2026-04-01', 'FY2026-27'],
    ['2026-10-28', 'FY2026-27'],
    ['2027-03-31', 'FY2026-27'],
    ['2027-04-01', 'FY2027-28'],
    ['2026-03-31', 'FY2025-26'],
    ['2026-01-01', 'FY2025-26'],
    ['2026-12-31', 'FY2026-27'],
  ])('puts %s in %s', (day, key) => {
    expect(financialYearOf(day).key).toBe(key);
  });

  it('writes the closing year with two digits, also across a century', () => {
    expect(financialYearOf('2099-04-01').key).toBe('FY2099-00');
    expect(financialYearOf('2009-05-01').key).toBe('FY2009-10');
  });

  it.each(['2026-4-1', '2026-04-01T00:00:00Z', 'today', ''])('refuses %j', (day) => {
    expect(() => financialYearOf(day)).toThrow(RangeError);
  });
});

describe('invoice numbers', () => {
  it('start with BNX and the financial year, then a four-digit number', () => {
    const prefix = platformInvoicePrefix(financialYearOf('2026-10-28'));
    expect(prefix).toBe('BNX/FY2026-27/');
    expect(formatNumber(prefix, 7, PLATFORM_INVOICE_WIDTH)).toBe('BNX/FY2026-27/0007');
  });

  it('keeps every digit of a number wider than the padding', () => {
    expect(formatNumber('BNX/FY2026-27/', 12345, 4)).toBe('BNX/FY2026-27/12345');
  });
});
