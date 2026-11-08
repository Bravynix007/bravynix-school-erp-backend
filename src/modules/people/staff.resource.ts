import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { EducationRow, EmergencyContactRow, StaffRow } from './staff.repository.js';

export interface EducationResource {
  degree: string;
  qualification: string | null;
  specialization: string | null;
  institutionName: string | null;
  yearOfPassing: number | null;
}

export interface EmergencyContactResource {
  contactName: string;
  relation: string | null;
  phone: { countryCode: string; number: string };
  alternateNumber: string | null;
  isPrimary: boolean;
}

/** One staff member as an admin sees them (API design 9.5). Identity numbers and documents arrive with their own endpoints. */
export interface StaffResource extends AuthorStamps {
  id: string;
  homeInstitutionId: string;
  /** The login: who signs in as this staff member. */
  person: { id: string; email: string };
  employeeCode: string | null;
  firstName: string;
  lastName: string | null;
  gender: number | null;
  dateOfBirth: string | null;
  bloodGroup: string | null;
  nationality: string | null;
  photoFileId: string | null;
  designationId: string | null;
  classCategoryId: string;
  mobile: { countryCode: string; number: string };
  alternateNumber: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    countryId: string | null;
    stateId: string | null;
    cityId: string | null;
    pincode: string | null;
  };
  joiningDate: string | null;
  resignationDate: string | null;
  employmentType: number | null;
  educations: EducationResource[];
  emergencyContacts: EmergencyContactResource[];
  status: number;
  version: number;
}

export function staffResource(
  row: StaffRow,
  educations: readonly EducationRow[],
  contacts: readonly EmergencyContactRow[],
  email: string,
  people: ReadonlyMap<string, AuthorRef>,
): StaffResource {
  return {
    id: row.id,
    homeInstitutionId: row.home_institution_id,
    person: { id: row.user_id, email },
    employeeCode: row.employee_code,
    firstName: row.first_name,
    lastName: row.last_name,
    gender: row.gender,
    dateOfBirth: row.date_of_birth,
    bloodGroup: row.blood_group,
    nationality: row.nationality,
    photoFileId: row.photo_file_id,
    designationId: row.designation_id,
    classCategoryId: row.class_category_id,
    mobile: { countryCode: row.country_code, number: row.mobile_number },
    alternateNumber: row.alternate_phone,
    address: {
      line1: row.address_line_1,
      line2: row.address_line_2,
      countryId: row.country_id,
      stateId: row.state_id,
      cityId: row.city_id,
      pincode: row.pincode,
    },
    joiningDate: row.joining_date,
    resignationDate: row.resignation_date,
    employmentType: row.employment_type,
    educations: educations.map((education) => ({
      degree: education.degree,
      qualification: education.qualification,
      specialization: education.specialization,
      institutionName: education.institution_name,
      yearOfPassing: education.year_of_passing,
    })),
    emergencyContacts: contacts.map((contact) => ({
      contactName: contact.contact_name,
      relation: contact.relation,
      phone: { countryCode: contact.country_code, number: contact.phone_number },
      alternateNumber: contact.alternate_phone,
      isPrimary: contact.is_primary,
    })),
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
