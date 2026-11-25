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

/** The highest grade point a band may carry (DDD 9.7: `MAX_GRADE_POINT`). */
export const MAX_GRADE_POINT = 10;

/** A band's range runs upwards: a minimum above the maximum is 400 `OUT_OF_RANGE` on `maxPercentage`. */
export function requireRange(minPercentage: number, maxPercentage: number): void {
  if (minPercentage > maxPercentage) {
    throw AppException.validation([fieldError('maxPercentage', FieldErrorCode.OUT_OF_RANGE)]);
  }
}

/** A numeric column as the API writes it: the database's `"90.50"` is `90.5`, and an empty one stays `null`. */
export function decimalOf(value: string): number;
export function decimalOf(value: string | null): number | null;
export function decimalOf(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * The database enforces the rules no race can break; a violation is the answer: a name already used by an active band
 * of the Institution is 409 `DUPLICATE` on `name`, a range that shares a value with another active band is 409
 * `GRADE_BAND_OVERLAP`.
 */
export function translateGradeBandError(error: unknown): unknown {
  if (isDuplicateOn(error, 'uq_grade_bands_institution_name')) return duplicateOn('name');
  if (isViolationOf(error, PgErrorCode.exclusionViolation, 'ex_grade_bands_no_overlap')) {
    return new AppException(HttpStatus.CONFLICT, ErrorCode.GRADE_BAND_OVERLAP, {
      errors: [fieldError('minPercentage', ErrorCode.GRADE_BAND_OVERLAP)],
    });
  }
  return error;
}
