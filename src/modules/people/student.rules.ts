import { AppException, type FieldError } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import type { AuditValues } from '../../platform/audit/index.js';
import type { GuardianDto } from './student.dto.js';
import type { GuardianRow, PlacedRow, StudentRow } from './student.repository.js';

/** The dates of a student's record that must agree with each other (PRD 7.6). */
export interface StudentDatesInput {
  dateOfBirth?: string | null;
  admissionDate?: string | null;
}

/** What a new student's dates and guardians must satisfy beyond the shape of the body (PRD 7.6, DDD 9.6). */
export interface StudentRuleInput extends StudentDatesInput {
  guardians: readonly Pick<GuardianDto, 'isPrimary' | 'email'>[];
}

/** The earliest year a date of birth can be, as for staff (a typing slip, not a person). */
const EARLIEST_BIRTH = '1900-01-01';

/** The date problems: the date of birth is from 1900 and before `today`, and the admission is not before it. */
function dateProblems(input: StudentDatesInput, today: string): FieldError[] {
  const problems: FieldError[] = [];
  if (input.dateOfBirth && (input.dateOfBirth >= today || input.dateOfBirth < EARLIEST_BIRTH)) {
    problems.push(fieldError('dateOfBirth', FieldErrorCode.INVALID_VALUE));
  }
  if (input.dateOfBirth && input.admissionDate && input.admissionDate < input.dateOfBirth) {
    problems.push(fieldError('admissionDate', FieldErrorCode.INVALID_VALUE));
  }
  return problems;
}

/**
 * 400 `INVALID_VALUE` on a date that breaks a rule: the date of birth is from 1900 and before `today`, and the
 * admission date is not before it. STU-04 checks the dates as they will stand, the stored one for a field not sent.
 */
export function requireValidDates(input: StudentDatesInput, today: string): void {
  const problems = dateProblems(input, today);
  if (problems.length > 0) throw AppException.validation(problems);
}

/**
 * 400 `INVALID_VALUE` on every field that breaks a rule, in the order of the form: the dates as above, and no two
 * guardians share an email (one email is one person, so the second would be the same login twice). Then 422
 * `PRIMARY_GUARDIAN_REQUIRED` unless exactly one guardian is primary. Dates are `YYYY-MM-DD`, so they compare as text.
 */
export function requireValidStudent(input: StudentRuleInput, today: string): void {
  const problems = dateProblems(input, today);
  const seen = new Set<string>();
  input.guardians.forEach((guardian, index) => {
    const email = guardian.email?.toLowerCase();
    if (email === undefined) return;
    if (seen.has(email))
      problems.push(fieldError(`guardians[${index}].email`, FieldErrorCode.INVALID_VALUE));
    seen.add(email);
  });
  if (problems.length > 0) throw AppException.validation(problems);
  if (input.guardians.filter((guardian) => guardian.isPrimary).length !== 1) {
    throw AppException.businessRule(ErrorCode.PRIMARY_GUARDIAN_REQUIRED);
  }
}

/**
 * STU-08: the last day a move can take effect: today, or the day the current placement begins when that is later (a
 * child placed from a later day, as one admitted ahead, is corrected in place), and never after the year ends.
 */
export function latestMoveDate(currentStart: string, today: string, yearEnd: string): string {
  const latest = today > currentStart ? today : currentStart;
  return latest < yearEnd ? latest : yearEnd;
}

/**
 * STU-08: the move takes effect on a day that is not before the current placement began (the old row must keep at
 * least its first day) and not after `latestMoveDate`. 400 `INVALID_VALUE` on `effectiveDate` otherwise.
 */
export function requireValidMoveDate(
  effectiveDate: string,
  currentStart: string,
  today: string,
  yearEnd: string,
): void {
  if (
    effectiveDate > latestMoveDate(currentStart, today, yearEnd) ||
    effectiveDate < currentStart
  ) {
    throw AppException.validation([fieldError('effectiveDate', FieldErrorCode.INVALID_VALUE)]);
  }
}

/** `******3210`: enough to tell which number, not enough to use it. */
const maskPhone = (number: string): string =>
  `${'*'.repeat(Math.max(number.length - 4, 0))}${number.slice(-4)}`;

/**
 * What the audit log keeps of a student (DDD 9.12): names, codes, dates and where the child sits. The email, the
 * address lines and the guardians' numbers and emails are personal data the entry does not need, so they are left out;
 * a phone number shows as its last four digits.
 */
export function studentAuditView(
  row: StudentRow,
  placed: PlacedRow | undefined,
  guardians: readonly GuardianRow[],
): AuditValues {
  return {
    admissionNo: row.admission_no,
    firstName: row.first_name,
    lastName: row.last_name,
    gender: row.gender,
    dateOfBirth: row.date_of_birth,
    bloodGroup: row.blood_group,
    nationality: row.nationality,
    photoFileId: row.photo_file_id,
    admissionDate: row.admission_date,
    mobile: row.mobile_number === null ? null : maskPhone(row.mobile_number),
    alternateNumber: row.alternate_number === null ? null : maskPhone(row.alternate_number),
    addressLines: [row.address_line_1, row.address_line_2].filter(Boolean).length,
    countryId: row.country_id,
    stateId: row.state_id,
    cityId: row.city_id,
    pincode: row.pincode,
    academicYearId: placed?.academic_year_id ?? null,
    classId: placed?.class_id ?? null,
    sectionId: placed?.section_id ?? null,
    rollNumber: placed?.roll_number ?? null,
    guardians: guardians.map((guardian) => ({
      firstName: guardian.first_name,
      lastName: guardian.last_name,
      relation: guardian.relation,
      phone: maskPhone(guardian.phone_number),
      hasLogin: guardian.user_id !== null,
      isPrimary: guardian.is_primary,
      isEmergencyContact: guardian.is_emergency_contact,
    })),
    status: row.status,
    inactiveReason: row.inactive_reason,
  };
}
