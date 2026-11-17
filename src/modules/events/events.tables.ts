import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Events tables (DDD 9.8). A business module adds its tables to `Database` here, so the
 * platform layer never imports a module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    events: EventsTable;
    event_holiday_classes: EventHolidayClassesTable;
  }
}

/** One event of a Society or of one Institution, a holiday or not. Deactivated (`status` 0), never deleted. */
export interface EventsTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  version: Generated<number>;
  /** 1 active, 0 deactivated. */
  status: Generated<number>;
  society_id: string;
  /** 1 Society (shown in every Institution), 2 Institution. */
  scope: number;
  /** Set exactly when `scope` is 2. */
  institution_id: string | null;
  title: string;
  description: string | null;
  venue: string | null;
  /** `YYYY-MM-DD`. */
  start_date: string;
  end_date: string;
  duration_label: string;
  /** 1 Everyone, 2 Students and parents, 3 Staff. */
  audience: Generated<number>;
  preset_image_code: string | null;
  is_holiday: Generated<boolean>;
  /** 1 Public holiday, 2 Vacation, 3 Event holiday, 4 Optional; set exactly when `is_holiday`. */
  holiday_type: number | null;
  holiday_for_students: Generated<boolean>;
  holiday_for_staff: Generated<boolean>;
}

/** The predefined classes a holiday is limited to; no rows means every class. */
interface EventHolidayClassesTable {
  event_id: string;
  predefined_class_id: string;
  society_id: string;
}
