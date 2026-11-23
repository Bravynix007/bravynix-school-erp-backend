import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Attendance tables (DDD 9.7). A business module adds its tables to `Database` here, so the
 * platform layer never imports a module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    attendance_sessions: AttendanceSessionsTable;
    attendance_exceptions: AttendanceExceptionsTable;
  }
}

/** One marking of one section on one date (V1: once a day). Voided (`status` 0) by an admin, never deleted. */
export interface AttendanceSessionsTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  version: Generated<number>;
  /** 1 active, 0 voided. */
  status: Generated<number>;
  society_id: string;
  institution_id: string;
  academic_year_id: string;
  section_id: string;
  /** `YYYY-MM-DD`. */
  attendance_date: string;
  /** 2 Daily; 1 Period is kept for later and is not used. */
  attendance_mode: Generated<number>;
  time_slot_id: string | null;
  subject_id: string | null;
  /** The home-Institution staff member who marked it; empty when an admin with no staff record did. */
  taken_by_staff_member_id: string | null;
  roster_count: number;
  absent_count: Generated<number>;
  late_count: Generated<number>;
  half_day_count: Generated<number>;
  leave_count: Generated<number>;
  /** Stored, generated from the counts above. */
  present_count: ColumnType<number, never, never>;
  submitted_at: ColumnType<Date, Date | undefined, never>;
  submitted_by: string;
  last_corrected_at: Date | null;
  last_corrected_by: string | null;
}

/** A student who was not Present in a session: 2 Absent, 3 Late, 4 Half day, 5 Leave. Present is never stored. */
export interface AttendanceExceptionsTable {
  attendance_session_id: string;
  student_enrolment_id: string;
  /** `YYYY-MM-DD`, the session's date (the partition key). */
  attendance_date: string;
  institution_id: string;
  attendance_status: number;
  corrected_at: Date | null;
  corrected_by: string | null;
}
