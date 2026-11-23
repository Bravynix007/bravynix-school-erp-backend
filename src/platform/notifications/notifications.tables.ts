import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely type of `inbox_items` (DDD 9.8): one row per receiver of a notice, partitioned by month on `created_at`.
 * A row is read, marked read and cleared only by its receiver.
 */
export interface InboxItemsTable {
  id: Generated<string>;
  /** The time of the source event, which the worker copies, so a rerun of a fan-out finds the same row. */
  created_at: ColumnType<Date, Date | undefined, never>;
  user_id: string;
  society_id: string | null;
  institution_id: string | null;
  /** The child the notice is about, for the parent's child switcher. */
  student_id: string | null;
  /** 0 Account, then as `notification_preferences`: 1 Attendance, 2 Diary, 3 Events and holidays, and so on. */
  category: number;
  /** 1 Only for you, 2 All, 3 All teachers, 4 All students. */
  inbox_tab: Generated<number>;
  title: string;
  body: string;
  sender_display_name: string | null;
  announcement_id: string | null;
  /** What produced the item, such as `absent:<session>:<enrolment>`; with the receiver and the time, unique. */
  source_key: string;
  /** The screen it opens: 1 Attendance, 2 Diary, 3 Event, 4 Exam, and so on (DDD 9.8). */
  target_type: number | null;
  target_id: string | null;
  /** The day the notice is about, such as the date of a diary entry; only with a target. */
  target_date: string | null;
  read_at: Date | null;
}

/** Kysely type of `push_devices` (DDD 9.1): the push token of a phone, tied to the session that registered it. */
export interface PushDevicesTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  user_id: string;
  session_id: string;
  fcm_token: string;
  /** 1 Android, 2 iOS. */
  platform: number;
  app_version: string | null;
  app_language: Generated<string>;
  last_seen_at: ColumnType<Date, Date | undefined, Date>;
}
