import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import { rateInForce, type DatedRate } from './price-rate.rules.js';

/** The codes of the dues rules (API design 10.22), all 422. */
export const DueErrorCode = {
  NO_RATE_IN_FORCE: 'NO_RATE_IN_FORCE',
  TOTAL_NEGATIVE: 'TOTAL_NEGATIVE',
  NOTE_REQUIRED: 'NOTE_REQUIRED',
} as const;

/**
 * The student count the system works out by itself. It stays 0 until the People
 * module (Phase 4) holds students, so for now every count is typed by hand with a
 * note saying where it came from (Phase 2 scope decision, 28 October 2026).
 */
export const STUDENT_COUNT_AUTO = 0;

/** A due's state (DDD 9.10). */
export const DueStatus = { Cancelled: 0, Due: 1, Paid: 2 } as const;
export type DueStatus = (typeof DueStatus)[keyof typeof DueStatus];

/** How a due was paid (PRD 11.4): 1 Cash, 2 Bank transfer, 3 UPI, 4 Cheque. */
export const PAYMENT_MODES = [1, 2, 3, 4] as const;

/** The largest amount the money columns hold: numeric(12,2). */
const MAX_CENTS = 999_999_999_999n;

/** `"1234.50"` as paise-sized whole units (1/100 rupee). The input is already a validated two-decimal string. */
export function toCents(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole, fraction] = amount.replace('-', '').split('.') as [string, string];
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const text = `${String(absolute / 100n)}.${String(absolute % 100n).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** The period runs forward: the end is on or after the start, else 400 on `periodEndDate`. */
export function requirePeriod(periodStartDate: string, periodEndDate: string): void {
  if (periodEndDate < periodStartDate) {
    throw AppException.validation([fieldError('periodEndDate', FieldErrorCode.OUT_OF_RANGE)]);
  }
}

/** Only a due that is still Due can be edited, paid or cancelled: Paid and Cancelled are final, else 409 `INVALID_STATE`. */
export function requireDue(status: number): void {
  if (status !== DueStatus.Due) throw AppException.conflict(ErrorCode.INVALID_STATE);
}

/** Money cannot have arrived tomorrow: the paid date is today (India) or earlier, else 400 on `paidDate`. */
export function requirePaidByToday(paidDate: string, today: string): void {
  if (paidDate > today) {
    throw AppException.validation([fieldError('paidDate', FieldErrorCode.OUT_OF_RANGE)]);
  }
}

/** What a Society still owes BravyNix: the total of its dues that are still Due (PRD 9.3). */
export function outstandingAmount(
  dues: readonly { due_status: number; total_amount: string }[],
): string {
  return fromCents(
    dues
      .filter((due) => due.due_status === DueStatus.Due)
      .reduce((sum, due) => sum + toCents(due.total_amount), 0n),
  );
}

/** The rate a period starts under (PRD 9.2), or 422 `NO_RATE_IN_FORCE` when the first rate starts later. */
export function rateAtPeriodStart<R extends DatedRate>(
  rates: readonly R[],
  periodStartDate: string,
): R {
  const rate = rateInForce(rates, periodStartDate);
  if (!rate) {
    throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, DueErrorCode.NO_RATE_IN_FORCE, {
      errors: [fieldError('periodStartDate', DueErrorCode.NO_RATE_IN_FORCE)],
    });
  }
  return rate;
}

export interface DueAmounts {
  baseAmount: string;
  totalAmount: string;
}

/**
 * The base (students times the rate) and the total (base plus the signed
 * adjustment). Exact, with whole numbers only. A total below zero is 422
 * `TOTAL_NEGATIVE`; an amount the column cannot hold is 400 on the field that
 * made it too large.
 */
export function dueAmounts(
  studentCount: number,
  rateAmount: string,
  adjustmentAmount: string,
): DueAmounts {
  const base = BigInt(studentCount) * toCents(rateAmount);
  if (base > MAX_CENTS) {
    throw AppException.validation([fieldError('studentCount', FieldErrorCode.OUT_OF_RANGE)]);
  }
  const total = base + toCents(adjustmentAmount);
  if (total < 0n) {
    throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, DueErrorCode.TOTAL_NEGATIVE, {
      errors: [fieldError('adjustmentAmount', DueErrorCode.TOTAL_NEGATIVE)],
    });
  }
  if (total > MAX_CENTS) {
    throw AppException.validation([fieldError('adjustmentAmount', FieldErrorCode.OUT_OF_RANGE)]);
  }
  return { baseAmount: fromCents(base), totalAmount: fromCents(total) };
}

/** The notes a due needs: a changed student count and a non-zero adjustment each say why (API design 10.22). */
export function requireNotes(input: {
  studentCount: number;
  studentCountAuto: number;
  studentCountNote: string | null;
  adjustmentAmount: string;
  adjustmentNote: string | null;
}): void {
  const missing = [];
  if (input.studentCount !== input.studentCountAuto && input.studentCountNote === null) {
    missing.push(fieldError('studentCountNote', DueErrorCode.NOTE_REQUIRED));
  }
  if (toCents(input.adjustmentAmount) !== 0n && input.adjustmentNote === null) {
    missing.push(fieldError('adjustmentNote', DueErrorCode.NOTE_REQUIRED));
  }
  if (missing.length > 0) {
    throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, DueErrorCode.NOTE_REQUIRED, {
      errors: missing,
    });
  }
}

/** `1234567.5` as the Indian grouping people read, `12,34,567.50`. */
export function rupees(amount: string): string {
  const [whole, fraction] = amount.split('.') as [string, string];
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `₹${grouped}.${fraction}`;
}
