import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the Exams tables (DDD 9.7). A business module adds its tables to `Database` here, so the platform
 * layer never imports a module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    grade_bands: GradeBandsTable;
    exams: ExamsTable;
    exam_papers: ExamPapersTable;
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

/**
 * One exam of an Institution's academic year, such as "Unit Test 1". The dates are calendar days (`YYYY-MM-DD`).
 * Deactivated (`status` 0), never deleted.
 */
export interface ExamsTable {
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
  /** Unique among the year's active exams, any letter case. */
  name: string;
  /** 1 Unit test, 2 Mid term, 3 Final, 4 Quarterly, 5 Half yearly, 6 Annual (PRD 11.4). */
  exam_type: number;
  start_date: string;
  end_date: string;
  /** When the datesheet was published to the sections (EXM-09), and by whom; both empty until then. */
  datesheet_published_at: Date | null;
  datesheet_published_by: string | null;
}

/**
 * One paper of an exam: a subject sat by a section on a day, from a time to a time (`HH:MM:SS`). Both people are
 * optional and belong to the Institution. Deactivated (`status` 0), never deleted.
 */
export interface ExamPapersTable {
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
  exam_id: string;
  section_id: string;
  subject_id: string;
  exam_date: string;
  start_time: string;
  end_time: string;
  room_name: string | null;
  /** 1 to 1,000. */
  max_marks: Generated<number>;
  /** 0 up to `max_marks`. */
  passing_marks: Generated<number>;
  subject_teacher_staff_member_id: string | null;
  invigilator_staff_member_id: string | null;
}
