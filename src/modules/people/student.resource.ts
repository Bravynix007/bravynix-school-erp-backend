import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { GuardianRow, PlacedRow, StudentListRow, StudentRow } from './student.repository.js';

export interface GuardianResource {
  id: string;
  firstName: string;
  lastName: string | null;
  relation: number;
  phone: { countryCode: string; number: string };
  alternatePhone: string | null;
  email: string | null;
  occupation: string | null;
  isPrimary: boolean;
  isEmergencyContact: boolean;
  /** The guardian has a Student / Parent login: an email links one. */
  hasLogin: boolean;
}

/** Where the student sits: the class for the year, the section and the roll number there, and since when. */
export interface StudentPlacementResource {
  enrolmentId: string;
  academicYearId: string;
  classId: string;
  sectionId: string;
  rollNumber: string;
  /** First day in the class this year. */
  enrolledDate: string;
  /** First day in this section with this roll number. */
  startDate: string;
}

/** One student as an admin sees them (API design 9.6): the record, where the child sits and the guardians. */
export interface StudentResource extends AuthorStamps {
  id: string;
  institutionId: string;
  admissionNo: string | null;
  firstName: string;
  lastName: string | null;
  gender: number | null;
  dateOfBirth: string | null;
  bloodGroup: string | null;
  nationality: string | null;
  photoFileId: string | null;
  admissionDate: string | null;
  contactEmail: string | null;
  mobile: { countryCode: string; number: string } | null;
  alternateNumber: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    countryId: string | null;
    stateId: string | null;
    cityId: string | null;
    pincode: string | null;
  };
  placement: StudentPlacementResource | null;
  guardians: GuardianResource[];
  status: number;
  version: number;
}

/** One row of the students list (STU-01); the profile has the rest. */
export interface StudentSummary {
  id: string;
  institutionId: string;
  admissionNo: string | null;
  firstName: string;
  lastName: string | null;
  photoFileId: string | null;
  placement: StudentPlacementResource;
  status: number;
  version: number;
}

const placementResource = (placed: PlacedRow): StudentPlacementResource => ({
  enrolmentId: placed.enrolment_id,
  academicYearId: placed.academic_year_id,
  classId: placed.class_id,
  sectionId: placed.section_id,
  rollNumber: placed.roll_number,
  enrolledDate: placed.enrolled_date,
  startDate: placed.start_date,
});

export const guardianResource = (row: GuardianRow): GuardianResource => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  relation: row.relation,
  phone: { countryCode: row.country_code, number: row.phone_number },
  alternatePhone: row.alternate_phone,
  email: row.email,
  occupation: row.occupation,
  isPrimary: row.is_primary,
  isEmergencyContact: row.is_emergency_contact,
  hasLogin: row.user_id !== null,
});

export function studentSummary(row: StudentListRow): StudentSummary {
  return {
    id: row.id,
    institutionId: row.institution_id,
    admissionNo: row.admission_no,
    firstName: row.first_name,
    lastName: row.last_name,
    photoFileId: row.photo_file_id,
    placement: placementResource(row),
    status: row.status,
    version: row.version,
  };
}

export function studentResource(
  row: StudentRow,
  placed: PlacedRow | undefined,
  guardians: readonly GuardianRow[],
  people: ReadonlyMap<string, AuthorRef>,
): StudentResource {
  return {
    id: row.id,
    institutionId: row.institution_id,
    admissionNo: row.admission_no,
    firstName: row.first_name,
    lastName: row.last_name,
    gender: row.gender,
    dateOfBirth: row.date_of_birth,
    bloodGroup: row.blood_group,
    nationality: row.nationality,
    photoFileId: row.photo_file_id,
    admissionDate: row.admission_date,
    contactEmail: row.contact_email,
    mobile:
      row.country_code === null || row.mobile_number === null
        ? null
        : { countryCode: row.country_code, number: row.mobile_number },
    alternateNumber: row.alternate_number,
    address: {
      line1: row.address_line_1,
      line2: row.address_line_2,
      countryId: row.country_id,
      stateId: row.state_id,
      cityId: row.city_id,
      pincode: row.pincode,
    },
    placement: placed ? placementResource(placed) : null,
    guardians: guardians.map(guardianResource),
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
