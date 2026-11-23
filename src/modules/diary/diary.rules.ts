import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { addDays } from '../../common/time/calendar-days.js';
import type { YearSpan } from '../academic-setup/index.js';

/** How many days back an entry may be dated (PRD 7.9, DDD 9.7). */
export const MAX_BACKDATE_DAYS = 7;

/** The longest description (DDD 9.7). */
export const MAX_DESCRIPTION_LENGTH = 2000;

const refuse = (code: string): never => {
  throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, code);
};

/**
 * The date rules of an entry, in their order (API design 10.14a): the day has not to come (422 `DATE_IN_FUTURE`, by the
 * IST calendar), it is at most `MAX_BACKDATE_DAYS` back (422 `DATE_TOO_OLD`), and it is in the year (422
 * `DATE_OUTSIDE_CURRENT_YEAR`). Dates are `YYYY-MM-DD`, so they compare as text.
 */
export function requireDiaryDate(date: string, today: string, year: YearSpan): void {
  if (date > today) refuse(ErrorCode.DATE_IN_FUTURE);
  if (date < addDays(today, -MAX_BACKDATE_DAYS)) refuse(ErrorCode.DATE_TOO_OLD);
  if (date < year.startDate || date > year.endDate) refuse(ErrorCode.DATE_OUTSIDE_CURRENT_YEAR);
}
