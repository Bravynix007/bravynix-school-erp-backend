import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely type of `number_sequences` (DDD 9.1): the gap-free counters behind
 * receipt, enquiry and platform invoice numbers.
 */
export interface NumberSequencesTable {
  id: Generated<string>;
  updated_at: ColumnType<Date, never, Date>;
  /** 1 fee receipt, 2 admission enquiry, 3 platform invoice. */
  sequence_type: number;
  /** Empty only for platform invoices. */
  society_id: string | null;
  institution_id: string | null;
  /** The academic year (`2026-2027`) for receipts and enquiries, the financial year (`FY2026-27`) for invoices. */
  period_key: string;
  prefix: string;
  /** The number the next caller takes; a bigint kept as a JS number. */
  next_value: number;
}
