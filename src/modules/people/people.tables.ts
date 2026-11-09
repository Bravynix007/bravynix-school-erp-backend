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
