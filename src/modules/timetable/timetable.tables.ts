import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Timetable tables (DDD 9.4). A business module adds its tables to `Database` here, so the
 * platform layer never imports a module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    time_slots: TimeSlotsTable;
    timetable_entries: TimetableEntriesTable;
  }
}

/** One period of an Institution's academic year, a break or not. Deactivated (`status` 0), never deleted. */
export interface TimeSlotsTable {
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
  /** 1 to 30, unique among the year's active periods. */
  period_no: number;
  label: string | null;
  /** `HH:MM:SS` as the database writes a `time`. */
  start_time: string;
  end_time: string;
  is_break: Generated<boolean>;
}

/** One lesson or break of a section in a day and period of the week. Deactivated (`status` 0), never deleted. */
export interface TimetableEntriesTable {
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
  /** 1 Monday to 7 Sunday; the service offers 1 to 6. */
  day_of_week: number;
  time_slot_id: string;
  is_break: Generated<boolean>;
  /** Set, with the teacher, exactly when the entry is not a break. */
  subject_id: string | null;
  staff_member_id: string | null;
}
