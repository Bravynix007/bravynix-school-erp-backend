import { AppException } from '../../common/http/app-exception.js';
import { FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import { duplicateOn, isDuplicateOn } from '../../platform/database/index.js';
import type { YearSpan } from '../academic-setup/index.js';

/** The kinds of exam (PRD 11.4): 1 Unit test, 2 Mid term, 3 Final, 4 Quarterly, 5 Half yearly, 6 Annual. */
export const EXAM_TYPES = [1, 2, 3, 4, 5, 6] as const;

/**
 * The dates an exam runs, as 400 on the one that is wrong (as AY-02 and EVT-02, not `END_BEFORE_START`; API design
 * 12.1): the end is not before the start, and both days fall inside the academic year, both ends included.
 */
export function requireDates(startDate: string, endDate: string, year: YearSpan): void {
  const errors = [];
  if (startDate < year.startDate || startDate > year.endDate) {
    errors.push(fieldError('startDate', FieldErrorCode.OUT_OF_RANGE));
  }
  if (endDate < startDate || endDate > year.endDate || endDate < year.startDate) {
    errors.push(fieldError('endDate', FieldErrorCode.OUT_OF_RANGE));
  }
  if (errors.length > 0) throw AppException.validation(errors);
}

/**
 * The database enforces the rule no race can break; a violation is the answer: a name already used by an active exam
 * of the year, in any letter case, is 409 `DUPLICATE` on `name`.
 */
export function translateExamError(error: unknown): unknown {
  return isDuplicateOn(error, 'uq_exams_year_name') ? duplicateOn('name') : error;
}
