import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Academic setup tables (DDD 9.4). A business module adds its tables to `Database` here, so
 * the platform layer never imports a module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    academic_years: AcademicYearsTable;
  }
}

/** One academic year of an Institution. Dates are `YYYY-MM-DD`; a year is deactivated (`status` 0), never deleted. */
export interface AcademicYearsTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  version: Generated<number>;
  /** 1 active, 0 deactivated. */
  status: Generated<number>;
  society_id: string;
  institution_id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: Generated<boolean>;
}
