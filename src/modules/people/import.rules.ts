import { isEmail } from 'class-validator';
import { PHONE_NUMBER } from '../../common/validation/phone.dto.js';
import type { OpenSection } from '../academic-setup/index.js';
import { IMPORT_HEADER, type CsvRow } from './import.csv.js';

/** The relation every imported guardian has (3 Guardian) and the country code of every phone (API design 10.8). */
export const IMPORT_RELATION = 3;
export const IMPORT_COUNTRY_CODE = '91';

/** Run results keep this many skipped rows with their reasons (DDD 9.12). */
export const MAX_ROW_ERRORS = 1_000;

/** A row error as IMP-03 shows it. */
/** `run_status` of an import and `runStatus` of its operation resource (API design 16.2, DDD 9.12). */
export const RunStatus = { Queued: 1, Running: 2, Completed: 3, Failed: 4 } as const;

export interface RowError {
  row: number;
  message: string;
}

/** What a row says about a student, once it passed every rule that needs no lookup of the student's own. */
export interface ImportedStudent {
  firstName: string;
  lastName: string | null;
  rollNumber: string;
  classId: string;
  sectionId: string;
  guardian: {
    firstName: string;
    lastName: string | null;
    phone: string;
    email: string | null;
  };
}

/** The active classes and sections of an Institution, found by the name a person types. */
export class SectionIndex {
  private readonly classes = new Map<string, OpenSection[]>();

  constructor(sections: readonly OpenSection[]) {
    for (const section of sections) {
      const key = lookupKey(section.className);
      this.classes.set(key, [...(this.classes.get(key) ?? []), section]);
    }
  }

  hasClass(name: string): boolean {
    return this.classes.has(lookupKey(name));
  }

  find(className: string, sectionName: string): OpenSection | undefined {
    const wanted = lookupKey(sectionName);
    return this.classes.get(lookupKey(className))?.find((s) => lookupKey(s.sectionName) === wanted);
  }
}

/** A name matches however it is cased and spaced: "9TH" and " 9th " are the class "9th". */
const lookupKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

const NAME_LENGTH = 100;
const ROLL_NUMBER_LENGTH = 20;
const EMAIL_LENGTH = 254;

/** A name split at its last space: "Asha Devi Rao" is first name "Asha Devi" and last name "Rao". */
export function splitName(name: string): { firstName: string; lastName: string | null } {
  const whole = name.trim().replace(/\s+/g, ' ');
  const at = whole.lastIndexOf(' ');
  return at < 0
    ? { firstName: whole, lastName: null }
    : { firstName: whole.slice(0, at), lastName: whole.slice(at + 1) };
}

/**
 * The digits of an Indian mobile number as people write it: spaces and hyphens are dropped, and a leading `+91` before
 * ten digits is the country code, which every imported phone has anyway. `null` when what is left is not 6 to 15 digits.
 */
export function phoneDigits(text: string): string | null {
  const compact = text.replace(/[\s-]/g, '');
  const digits = /^\+91\d{10}$/.test(compact) ? compact.slice(3) : compact;
  return PHONE_NUMBER.test(digits) ? digits : null;
}

/**
 * Checks one row of the file against the row rules (API design 10.8). The message names the problem in words an admin
 * can fix from the row, with a class or section name as they typed it: "'9th' is not a recognized class". A phone number
 * or an email is never repeated in a message, as the result is kept for 7 days. The rules that need the
 * database (a roll number already taken, a guardian email that cannot be linked) are checked when the row is saved.
 */
export function checkRow(
  { cells }: Pick<CsvRow, 'cells'>,
  sections: SectionIndex,
): { student: ImportedStudent } | { message: string } {
  if (cells.length !== IMPORT_HEADER.length) {
    return { message: `Expected ${IMPORT_HEADER.length} columns but found ${cells.length}` };
  }
  const [name, rollNumber, className, sectionName, guardianName, guardianPhone, guardianEmail] =
    cells.map((cell) => cell.trim()) as [string, string, string, string, string, string, string];

  if (name === '') return { message: 'Name is required' };
  const student = splitName(name);
  if (student.firstName.length > NAME_LENGTH || (student.lastName?.length ?? 0) > NAME_LENGTH) {
    return { message: `Name is longer than ${NAME_LENGTH} characters` };
  }
  if (rollNumber === '') return { message: 'RollNumber is required' };
  if (rollNumber.length > ROLL_NUMBER_LENGTH) {
    return { message: `RollNumber is longer than ${ROLL_NUMBER_LENGTH} characters` };
  }
  if (className === '') return { message: 'Class is required' };
  if (!sections.hasClass(className)) return { message: `'${className}' is not a recognized class` };
  if (sectionName === '') return { message: 'Section is required' };
  const section = sections.find(className, sectionName);
  if (!section) {
    return { message: `'${sectionName}' is not a recognized section of class '${className}'` };
  }
  if (guardianName === '') return { message: 'GuardianName is required' };
  const guardian = splitName(guardianName);
  if (guardian.firstName.length > NAME_LENGTH || (guardian.lastName?.length ?? 0) > NAME_LENGTH) {
    return { message: `GuardianName is longer than ${NAME_LENGTH} characters` };
  }
  if (guardianPhone === '') return { message: 'GuardianPhone is required' };
  const phone = phoneDigits(guardianPhone);
  if (phone === null) return { message: 'GuardianPhone is not a valid phone number' };
  if (guardianEmail !== '' && (guardianEmail.length > EMAIL_LENGTH || !isEmail(guardianEmail))) {
    return { message: 'GuardianEmail is not a valid email address' };
  }

  return {
    student: {
      ...student,
      rollNumber,
      classId: section.classId,
      sectionId: section.sectionId,
      guardian: {
        ...guardian,
        phone,
        email: guardianEmail === '' ? null : guardianEmail.toLowerCase(),
      },
    },
  };
}
