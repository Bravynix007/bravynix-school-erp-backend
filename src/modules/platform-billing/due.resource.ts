import {
  authorOf,
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
  cancelledBy: AuthorRef | null;
  cancelReason: string | null;
  version: number;
}

/** A line of the Owner's list (BIL-01). The invoice file arrives with the Files module (Phase 4), so it is null until then. */
export interface OwnerDueLine {
  id: string;
  invoiceNo: string;
  institution: { id: string; name: string };
  periodStartDate: string;
  periodEndDate: string;
  totalAmount: string;
  dueStatus: number;
  dueDate: string | null;
  paidDate: string | null;
  paymentMode: number | null;
  paymentReference: string | null;
  invoiceFile: null;
}

/** One due as its Owner reads it (BIL-02): what they were charged and how. BravyNix's own notes and stamps stay out. */
export interface OwnerDue extends OwnerDueLine {
  studentCount: number;
  ratePerStudentAmount: string;
  baseAmount: string;
  adjustmentAmount: string;
  adjustmentNote: string | null;
}

/** BIL-01: "You are due ₹X" and the dues, newest first. */
export interface OwnerDues {
  banner: { totalDueAmount: string; hasOpenDues: boolean };
  dues: OwnerDueLine[];
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
    cancelledBy: row.cancelled_by === null ? null : authorOf(row.cancelled_by, people),
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

export function ownerDueLine(
  row: DueRow,
  names: ReadonlyMap<string, InstitutionName>,
): OwnerDueLine {
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    institution: { id: row.institution_id, name: names.get(row.institution_id)?.name ?? '' },
    periodStartDate: row.period_start_date,
    periodEndDate: row.period_end_date,
    totalAmount: row.total_amount,
    dueStatus: row.due_status,
    dueDate: row.due_date,
    paidDate: row.paid_date,
    paymentMode: row.payment_mode,
    paymentReference: row.payment_reference,
    invoiceFile: null,
  };
}

export function ownerDue(row: DueRow, names: ReadonlyMap<string, InstitutionName>): OwnerDue {
  return {
    ...ownerDueLine(row, names),
    studentCount: row.student_count,
    ratePerStudentAmount: row.rate_per_student_amount,
    baseAmount: row.base_amount,
    adjustmentAmount: row.adjustment_amount,
    adjustmentNote: row.adjustment_note,
  };
}
