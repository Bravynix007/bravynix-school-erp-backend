import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Platform billing tables (DDD 9.10). A business module
 * adds its tables to `Database` here, so the platform layer never imports a
 * module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    institution_price_rates: InstitutionPriceRatesTable;
    platform_dues: PlatformDuesTable;
  }
}

/**
 * One rate of an Institution, effective from a date. Insert-only: a mistake is
 * corrected by a newer row. `rate_per_student_amount` is numeric(10,2), kept as
 * an exact decimal string.
 */
export interface InstitutionPriceRatesTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string;
  society_id: string;
  institution_id: string;
  rate_per_student_amount: string;
  /** A calendar date, `YYYY-MM-DD`. */
  effective_from_date: string;
  note: string | null;
}

/**
 * A due raised against an Institution for a period (DDD 9.10). The rate and every
 * amount are frozen when it is raised. Money columns are numeric, kept as exact
 * decimal strings; dates are `YYYY-MM-DD`. Never deleted.
 */
export interface PlatformDuesTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string;
  updated_at: ColumnType<Date, never, never>;
  updated_by: string | null;
  version: ColumnType<number, never, never>;
  society_id: string;
  institution_id: string;
  invoice_no: string;
  period_start_date: string;
  period_end_date: string;
  student_count_auto: number;
  student_count: number;
  student_count_note: string | null;
  price_rate_id: string;
  rate_per_student_amount: string;
  base_amount: string;
  adjustment_amount: string;
  adjustment_note: string | null;
  total_amount: string;
  due_date: string | null;
  /** 1 Due, 2 Paid, 0 Cancelled. */
  due_status: Generated<number>;
  paid_date: string | null;
  /** 1 Cash, 2 Bank transfer, 3 UPI, 4 Cheque. */
  payment_mode: number | null;
  payment_reference: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}
