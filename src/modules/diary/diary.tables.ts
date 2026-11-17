import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Diary table (DDD 9.7). A business module adds its tables to `Database` here, so the platform
 * layer never imports a module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    diary_entries: DiaryEntriesTable;
  }
}

/** The homework or note for a section and subject on a date. Deactivated (`status` 0), never deleted. */
export interface DiaryEntriesTable {
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
  academic_year_id: string;
  section_id: string;
  subject_id: string;
  /** The teacher who wrote it; empty for an admin with no staff record. */
  staff_member_id: string | null;
  diary_date: string;
  description: string;
}
