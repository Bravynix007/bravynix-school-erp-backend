import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import { duplicateOn, isDuplicateOn, PgErrorCode } from '../../platform/database/index.js';

/** A year ends after it starts (PRD 7.2): the end on or before the start is 400 on `endDate`. */
export function requireYearDates(startDate: string, endDate: string): void {
  if (endDate <= startDate) {
    throw AppException.validation([fieldError('endDate', FieldErrorCode.OUT_OF_RANGE)]);
  }
}

/**
 * The database enforces the rules no race can break; a violation is the answer: a name already used by an active
 * year is 409 `DUPLICATE` on `name`, an overlap with another active year is 409 `YEAR_OVERLAP`.
 */
export function translateYearError(error: unknown): unknown {
  if (isDuplicateOn(error, 'uq_academic_years_institution_name')) return duplicateOn('name');
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === PgErrorCode.exclusionViolation && constraint === 'ex_academic_years_no_overlap') {
    return new AppException(HttpStatus.CONFLICT, ErrorCode.YEAR_OVERLAP, {
      errors: [fieldError('startDate', ErrorCode.YEAR_OVERLAP)],
    });
  }
  return error;
}
