import { AppException, type FieldError } from '../../common/http/app-exception.js';
import { FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import type { AuditValues } from '../../platform/audit/index.js';
import type { EmergencyContactDto } from './staff.dto.js';
import type { EducationRow, EmergencyContactRow, StaffRow } from './staff.repository.js';

/** What a staff record's dates and contacts must satisfy beyond the shape of the body (PRD 7.5, DDD 9.5). */
export interface StaffRuleInput {
  dateOfBirth?: string | null;
  joiningDate?: string | null;
  resignationDate?: string | null;
  emergencyContacts?: readonly Pick<EmergencyContactDto, 'isPrimary'>[];
}

/**
 * 400 `INVALID_VALUE` on the first field that breaks a rule: the date of birth is before `today`, the resignation
 * is on or after the joining, and at most one emergency contact is primary. Dates are `YYYY-MM-DD`, so they compare
 * as text. The first problem found, in the order of the form.
 */
export function requireValidStaff(input: StaffRuleInput, today: string): void {
  const problems: FieldError[] = [];
  if (input.dateOfBirth && input.dateOfBirth >= today) {
    problems.push(fieldError('dateOfBirth', FieldErrorCode.INVALID_VALUE));
  }
  if (input.joiningDate && input.resignationDate && input.resignationDate < input.joiningDate) {
    problems.push(fieldError('resignationDate', FieldErrorCode.INVALID_VALUE));
  }
  const primaries = (input.emergencyContacts ?? [])
    .map((contact, index) => ({ contact, index }))
    .filter(({ contact }) => contact.isPrimary);
  for (const { index } of primaries.slice(1)) {
    problems.push(
      fieldError(`emergencyContacts[${index}].isPrimary`, FieldErrorCode.INVALID_VALUE),
    );
  }
  if (problems.length > 0) throw AppException.validation(problems);
}

/** `******3210`: enough to tell which number, not enough to use it. */
const maskPhone = (number: string): string =>
  `${'*'.repeat(Math.max(number.length - 4, 0))}${number.slice(-4)}`;

/**
 * What the audit log keeps of a staff record (DDD 9.12): names, codes, dates and the lists by their headings. The
 * email, the address lines and the emergency contacts' numbers are personal data the entry does not need, so they are
 * left out; a phone number shows as its last four digits.
 */
export function staffAuditView(
  row: StaffRow,
  educations: readonly EducationRow[],
  contacts: readonly EmergencyContactRow[],
): AuditValues {
  return {
    homeInstitutionId: row.home_institution_id,
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
    joiningDate: row.joining_date,
    resignationDate: row.resignation_date,
    employmentType: row.employment_type,
    mobile: maskPhone(row.mobile_number),
    alternatePhone: row.alternate_phone === null ? null : maskPhone(row.alternate_phone),
    addressLines: [row.address_line_1, row.address_line_2].filter(Boolean).length,
    countryId: row.country_id,
    stateId: row.state_id,
    cityId: row.city_id,
    pincode: row.pincode,
    educations: educations.map((line) => ({
      degree: line.degree,
      yearOfPassing: line.year_of_passing,
    })),
    emergencyContacts: contacts.map((contact) => ({
      contactName: contact.contact_name,
      isPrimary: contact.is_primary,
    })),
    status: row.status,
  };
}
