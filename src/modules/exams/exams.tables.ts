import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Exams tables (DDD 9.7). A business module adds its tables to `Database` here, so the platform
 * layer never imports a module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    grade_bands: GradeBandsTable;
  }
}

/**
 * One grade of an Institution, a range of percentages with both ends included. Percentages and the grade point are
 * numeric, read back as exact decimal strings (`"90.99"`) and written as numbers. Deactivated (`status` 0), never
 * deleted.
 */
export interface GradeBandsTable {
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
  /** Unique among the Institution's active bands, any letter case. */
  name: string;
  min_percentage: ColumnType<string, number, number>;
  max_percentage: ColumnType<string, number, number>;
  grade_point: ColumnType<string | null, number | null, number | null>;
  description: string | null;
}
