/** What a counter numbers (DDD 9.1 `number_sequences.sequence_type`). */
export const SequenceType = {
  FeeReceipt: 1,
  AdmissionEnquiry: 2,
  PlatformInvoice: 3,
} as const;
export type SequenceType = (typeof SequenceType)[keyof typeof SequenceType];

/** The Indian financial year a day falls in, which starts on 1 April. */
export interface FinancialYear {
  /** `FY2026-27`, the key of the invoice counter. */
  key: string;
  startYear: number;
}

/**
 * The financial year of a school day (`YYYY-MM-DD`): April 2026 to March 2027 is
 * `FY2026-27` (DDD 9.1; platform invoices run per financial year).
 */
export function financialYearOf(day: string): FinancialYear {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(day);
  if (!match) throw new RangeError(`Not a calendar day: ${day}`);
  const year = Number(match[1]);
  const startYear = Number(match[2]) >= 4 ? year : year - 1;
  const endYear = String((startYear + 1) % 100).padStart(2, '0');
  return { key: `FY${startYear}-${endYear}`, startYear };
}

/** `BNX/FY2026-27/`, the fixed start of every invoice number of that year. */
export function platformInvoicePrefix(year: FinancialYear): string {
  return `BNX/${year.key}/`;
}

/** The prefix followed by the number, zero-padded: `BNX/FY2026-27/0007`. Wider numbers keep every digit. */
export function formatNumber(prefix: string, issued: number, width: number): string {
  return `${prefix}${String(issued).padStart(width, '0')}`;
}

/** Digits of a platform invoice number; four, as in the examples (API design 10.22). */
export const PLATFORM_INVOICE_WIDTH = 4;
