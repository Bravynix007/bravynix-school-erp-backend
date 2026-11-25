import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import {
  duplicateOn,
  isDuplicateOn,
  isViolationOf,
  PgErrorCode,
} from '../../platform/database/index.js';

/** The longest school day the periods may number (DDD 9.4: `period_no` 1 to 30). */
export const MAX_PERIOD_NO = 30;

/**
 * The database enforces the rules no race can break; a violation is the answer: a number already used by an active
 * period of the year is 409 `DUPLICATE` on `periodNo`, an overlap with another active period is 409
 * `TIME_SLOT_OVERLAP`. Two periods that start together overlap, so that index answers the same.
 */
export function translateTimeSlotError(error: unknown): unknown {
  if (isDuplicateOn(error, 'uq_time_slots_year_period')) return duplicateOn('periodNo');
  if (
    isDuplicateOn(error, 'uq_time_slots_year_start') ||
    isViolationOf(error, PgErrorCode.exclusionViolation, 'ex_time_slots_no_overlap')
  ) {
    return new AppException(HttpStatus.CONFLICT, ErrorCode.TIME_SLOT_OVERLAP, {
      errors: [fieldError('startTime', ErrorCode.TIME_SLOT_OVERLAP)],
    });
  }
  return error;
}
