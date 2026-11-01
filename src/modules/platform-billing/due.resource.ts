import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { InstitutionName } from '../../platform/tenancy/index.js';
import type { DueRow } from './due.repository.js';

/** A line of the Dues ledger (PLT-25). */
export interface DueSummary {
  id: string;
  invoiceNo: string;
  societyId: string;
  societyName: string;
  institution: { id: string; name: string };
  periodStartDate: string;
  periodEndDate: string;
  totalAmount: string;
  dueStatus: number;
  dueDate: string | null;
  paidDate: string | null;
}

/** One due in full (PLT-26, PLT-27): the frozen rate and amounts, the notes, the payment and the stamps. */
export interface DueResource extends DueSummary, AuthorStamps {
  studentCountAuto: number;
  studentCount: number;
  studentCountNote: string | null;
  priceRateId: string;
  ratePerStudentAmount: string;
  baseAmount: string;
  adjustmentAmount: string;
  adjustmentNote: string | null;
  paymentMode: number | null;
  paymentReference: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  version: number;
}

/** PLT-24: what a due for a period starts from. The rate is null when none applies yet. */
export interface DueQuote {
  institutionId: string;
  periodStartDate: string;
  periodEndDate: string;
  studentCountAuto: number;
  priceRateId: string | null;
  ratePerStudentAmount: string | null;
  rateEffectiveFromDate: string | null;
  /** The automatic count times the rate; null with no rate. */
  baseAmount: string | null;
}

export function dueSummary(row: DueRow, names: ReadonlyMap<string, InstitutionName>): DueSummary {
  const institution = names.get(row.institution_id);
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    societyId: row.society_id,
    societyName: institution?.societyName ?? '',
    institution: { id: row.institution_id, name: institution?.name ?? '' },
    periodStartDate: row.period_start_date,
    periodEndDate: row.period_end_date,
    totalAmount: row.total_amount,
    dueStatus: row.due_status,
    dueDate: row.due_date,
    paidDate: row.paid_date,
  };
}

export function dueResource(
  row: DueRow,
  names: ReadonlyMap<string, InstitutionName>,
  people: ReadonlyMap<string, AuthorRef>,
): DueResource {
  return {
    ...dueSummary(row, names),
    studentCountAuto: row.student_count_auto,
    studentCount: row.student_count,
    studentCountNote: row.student_count_note,
    priceRateId: row.price_rate_id,
    ratePerStudentAmount: row.rate_per_student_amount,
    baseAmount: row.base_amount,
    adjustmentAmount: row.adjustment_amount,
    adjustmentNote: row.adjustment_note,
    paymentMode: row.payment_mode,
    paymentReference: row.payment_reference,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    version: row.version,
    ...authorStamps(row, people),
  };
}

/** Everyone the rows of a list name, for one lookup. */
export function peopleOfDues(rows: readonly DueRow[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) =>
        [row.created_by, row.updated_by, row.cancelled_by].filter((id) => id !== null),
      ),
    ),
  ];
}
