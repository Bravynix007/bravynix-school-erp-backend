import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import {
  duplicateOn,
  isDuplicateOn,
  isViolationOf,
  PgErrorCode,
} from '../../platform/database/index.js';

/** The most a paper may be marked out of (DDD 9.7: `max_marks` 1 to 1,000). */
export const MAX_MARKS_CEILING = 1000;

/** A paper marked out of 100 with 35 to pass, as the DDD defaults, unless the request says otherwise. */
export const DEFAULT_MAX_MARKS = 100;
export const DEFAULT_PASSING_MARKS = 35;

/** The days an exam runs, both ends included. */
export interface ExamWindow {
  startDate: string;
  endDate: string;
}

/** A paper is sat on a day the exam runs: any other day is 400 `OUT_OF_RANGE` on `examDate` (API design 12.6). */
export function requireExamDate(examDate: string, exam: ExamWindow): void {
  if (examDate < exam.startDate || examDate > exam.endDate) {
    throw AppException.validation([fieldError('examDate', FieldErrorCode.OUT_OF_RANGE)]);
  }
}

/** The passing marks are at most the maximum: more is 400 `OUT_OF_RANGE` on `passingMarks`. */
export function requirePassingMarks(maxMarks: number, passingMarks: number): void {
  if (passingMarks > maxMarks) {
    throw AppException.validation([fieldError('passingMarks', FieldErrorCode.OUT_OF_RANGE)]);
  }
}

/**
 * The marks of a new paper: the ones sent, or 100 and 35. The passing marks left out never exceed a maximum below 35,
 * so a paper marked out of 20 passes at 20 and not at 35; the caller names a lower mark to say otherwise.
 */
export function marksOf(
  maxMarks: number | undefined,
  passingMarks: number | undefined,
): { maxMarks: number; passingMarks: number } {
  const max = maxMarks ?? DEFAULT_MAX_MARKS;
  return { maxMarks: max, passingMarks: passingMarks ?? Math.min(DEFAULT_PASSING_MARKS, max) };
}

/**
 * The database has the last word on what no race can break, and a violation is the answer: a subject already set for
 * the section in this exam is 409 `DUPLICATE` on `subjectId`; a paper that overlaps another of the section is 409
 * `PAPER_OVERLAP`, one of the invigilator 409 `INVIGILATOR_DOUBLE_BOOKED`, one in the same room (any letter case) 409
 * `ROOM_TAKEN`, each naming the field to change.
 */
export function translatePaperError(error: unknown): unknown {
  if (isDuplicateOn(error, 'uq_exam_papers_exam_section_subject')) return duplicateOn('subjectId');
  const clashes: [string, string, string][] = [
    ['ex_exam_papers_section_time', ErrorCode.PAPER_OVERLAP, 'startTime'],
    [
      'ex_exam_papers_invigilator_time',
      ErrorCode.INVIGILATOR_DOUBLE_BOOKED,
      'invigilatorStaffMemberId',
    ],
    ['ex_exam_papers_room_time', ErrorCode.ROOM_TAKEN, 'roomName'],
  ];
  for (const [constraint, code, field] of clashes) {
    if (isViolationOf(error, PgErrorCode.exclusionViolation, constraint)) {
      return new AppException(HttpStatus.CONFLICT, code, { errors: [fieldError(field, code)] });
    }
  }
  return error;
}
