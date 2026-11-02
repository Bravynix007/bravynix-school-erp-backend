import { applyDecorators } from '@nestjs/common';
import { IsISO8601, IsString, Matches } from 'class-validator';

/** A date as the API writes it: `YYYY-MM-DD` (API design 7.4). */
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date in that form: `2027-02-29` and `2026-3-1` are 400. Put `@IsOptional()` or `@WhenPresent()`
 * in front where the field may be omitted or `null`.
 */
export const IsCalendarDate = () =>
  applyDecorators(IsString(), Matches(DATE_ONLY), IsISO8601({ strict: true }));
