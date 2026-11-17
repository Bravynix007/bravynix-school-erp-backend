import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import type { FieldError } from '../../common/http/field-error.type.js';
import { fieldError } from '../../common/validation/field-error.js';
import { isDuplicateOn } from '../../platform/database/index.js';

/** Monday to Saturday (PRD 7.8; Sunday is the weekly off, Phase 5 decision 5). */
export const LAST_SCHOOL_DAY = 6;

/** What a break or a lesson is made of: the subject and the teacher, set exactly when it is not a break. */
export interface EntryShape {
  isBreak: boolean;
  subjectId: string | null;
  staffMemberId: string | null;
}

/**
 * The second clash rule (API design 12.6): a lesson has a subject and a teacher, a break has neither. 400 `REQUIRED`
 * on what a lesson lacks, `FIELD_NOT_ALLOWED` on what a break names. Nothing is thrown when the shape is right.
 */
export function entryShapeErrors(entry: EntryShape): FieldError[] {
  if (entry.isBreak) {
    return [
      ...(entry.subjectId === null
        ? []
        : [fieldError('subjectId', FieldErrorCode.FIELD_NOT_ALLOWED)]),
      ...(entry.staffMemberId === null
        ? []
        : [fieldError('staffMemberId', FieldErrorCode.FIELD_NOT_ALLOWED)]),
    ];
  }
  return [
    ...(entry.subjectId === null ? [fieldError('subjectId', FieldErrorCode.REQUIRED)] : []),
    ...(entry.staffMemberId === null ? [fieldError('staffMemberId', FieldErrorCode.REQUIRED)] : []),
  ];
}

export function requireEntryShape(entry: EntryShape): void {
  const errors = entryShapeErrors(entry);
  if (errors.length > 0) throw AppException.validation(errors);
}

/**
 * The first clash rule: the period is one of the Institution's current year, and a break period takes only a break.
 * 400 `INVALID_SLOT` otherwise.
 */
export function requireUsableSlot(
  slot: { institutionId: string; academicYearId: string; isBreak: boolean },
  institutionId: string,
  currentYearId: string,
  entryIsBreak: boolean,
): void {
  if (
    slot.institutionId !== institutionId ||
    slot.academicYearId !== currentYearId ||
    (slot.isBreak && !entryIsBreak)
  ) {
    throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_SLOT);
  }
}

/** The last word of rules 5 and 6 when two saves race: the unique indexes answer the same codes, without the detail. */
export function translateEntryError(error: unknown): unknown {
  if (isDuplicateOn(error, 'uq_timetable_section_slot')) {
    return AppException.conflict(ErrorCode.SECTION_SLOT_TAKEN);
  }
  if (isDuplicateOn(error, 'uq_timetable_teacher_slot')) {
    return AppException.conflict(ErrorCode.TEACHER_DOUBLE_BOOKED);
  }
  return error;
}
