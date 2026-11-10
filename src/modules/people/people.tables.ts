import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types of the People tables (DDD 9.5, 9.6). A business module adds its tables to `Database` here, so the
 * platform layer never imports a module (SDD 9.3 rule 2).
 */
declare module '../../platform/database/schema.js' {
  interface Database {
    staff_members: StaffMembersTable;
    staff_educations: StaffEducationsTable;
    staff_emergency_contacts: StaffEmergencyContactsTable;
    staff_institutions: StaffInstitutionsTable;
    staff_subjects: StaffSubjectsTable;
    class_teacher_assignments: ClassTeacherAssignmentsTable;
    teaching_assignments: TeachingAssignmentsTable;
    staff_identities: StaffIdentitiesTable;
    documents: DocumentsTable;
  }
}

/** One staff member (teacher or other staff) of a Society, with a home Institution. Deactivated (`status` 0), never deleted. */
export interface StaffMembersTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  version: Generated<number>;
  /** 1 active, 0 deactivated. */
  status: Generated<number>;
  society_id: string;
  home_institution_id: string;
  user_id: string;
  employee_code: string | null;
  first_name: string;
  last_name: string | null;
  /** 1 Male, 2 Female, 3 Other. */
  gender: number | null;
  /** `YYYY-MM-DD`. */
  date_of_birth: string | null;
  blood_group: string | null;
  nationality: string | null;
  photo_file_id: string | null;
  designation_id: string | null;
  class_category_id: string;
  country_code: string;
  mobile_number: string;
  alternate_phone: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  country_id: string | null;
  state_id: string | null;
  city_id: string | null;
  pincode: string | null;
  joining_date: string | null;
  resignation_date: string | null;
  /** 1 Full time, 2 Part time, 3 Visiting, 4 Contract. */
  employment_type: number | null;
  /** Set with `access_blocked_by` when the staff role is blocked in this Society (STF-06); both empty otherwise. */
  access_blocked_at: Date | null;
  access_blocked_by: string | null;
}

/** One line of a staff member's education; the list is replaced whole in an edit. */
export interface StaffEducationsTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  society_id: string;
  staff_member_id: string;
  degree: string;
  qualification: string | null;
  specialization: string | null;
  institution_name: string | null;
  year_of_passing: number | null;
}

/** One emergency contact of a staff member; the list is replaced whole in an edit. */
export interface StaffEmergencyContactsTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  society_id: string;
  staff_member_id: string;
  contact_name: string;
  relation: string | null;
  country_code: string;
  phone_number: string;
  alternate_phone: string | null;
  is_primary: Generated<boolean>;
}

/** An extra Institution a staff member may see (STF-10); the home Institution is on the record itself. */
export interface StaffInstitutionsTable {
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  society_id: string;
  staff_member_id: string;
  institution_id: string;
}

/** A subject a staff member can teach (STF-08); the list is replaced whole. */
export interface StaffSubjectsTable {
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  society_id: string;
  staff_member_id: string;
  subject_id: string;
}

/** The columns the two assignment tables share. A row is only ever ended, never edited or deleted. */
interface AssignmentColumns {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  society_id: string;
  /** The staff member's home Institution: a teacher is assigned only where they work. */
  institution_id: string;
  academic_year_id: string;
  section_id: string;
  staff_member_id: string;
  /** Set with `ended_by` when the assignment ends; empty while it holds. */
  ended_at: ColumnType<Date | null, Date | null | undefined, Date>;
  ended_by: ColumnType<string | null, string | null | undefined, string>;
}

/** The class teacher of a section for one year (STF-09): one section a teacher, one teacher a section. */
export type ClassTeacherAssignmentsTable = AssignmentColumns;

/** A teacher teaching a subject in a section for one year (ASG-02). */
export interface TeachingAssignmentsTable extends AssignmentColumns {
  subject_id: string;
}

/**
 * A staff member's Aadhaar number (DDD 9.5, 15.6): sealed, hashed for duplicate checks and masked by its last four
 * digits. The four columns are all set or all empty; the row stays when the number is cleared.
 */
export interface StaffIdentitiesTable {
  staff_member_id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  version: Generated<number>;
  society_id: string;
  aadhaar_ciphertext: Buffer | null;
  aadhaar_key_version: number | null;
  aadhaar_hmac: Buffer | null;
  aadhaar_last4: string | null;
}

/** A file attached to a staff member (STF-15); deactivated (`status` 0) by DOC-03, never deleted. */
export interface DocumentsTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  /** 1 active, 0 deactivated. */
  status: Generated<number>;
  society_id: string;
  /** The staff member's home Institution. */
  institution_id: string;
  /** 2 staff member; 1 student arrives with the students table. */
  owner_type: number;
  staff_member_id: string | null;
  title: string;
  file_id: string;
}
