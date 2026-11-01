import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Platform billing tables (DDD 9.10). A business module
 * adds its tables to `Database` here, so the platform layer never imports a
 * module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    institution_price_rates: InstitutionPriceRatesTable;
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
