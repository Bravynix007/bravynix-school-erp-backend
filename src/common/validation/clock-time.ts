import { applyDecorators } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { AppException } from '../http/app-exception.js';
import { FieldErrorCode } from '../http/error-codes.js';
import { fieldError } from './field-error.js';

/** A time of day as the API writes it: `HH:MM`, 24-hour (API design 7.3). */
const TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real time of day in that form: `24:00` and `9:40` are 400. Put `@IsOptional()` or `@WhenPresent()` in front where the field may be omitted. */
export const IsClockTime = () => applyDecorators(IsString(), Matches(TIME_ONLY));

/** A time as the API writes it: the database's `09:40:00` is `09:40` (API design 7.3). */
export function clockOf(time: string): string {
  return time.slice(0, 5);
}

/** A span of the day ends after it starts: the end on or before the start is 400 `OUT_OF_RANGE` on `endTime`. */
export function requireTimes(startTime: string, endTime: string): void {
  if (endTime <= startTime) {
    throw AppException.validation([fieldError('endTime', FieldErrorCode.OUT_OF_RANGE)]);
  }
}
