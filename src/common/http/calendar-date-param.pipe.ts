import { Injectable, type PipeTransform } from '@nestjs/common';
import { isCalendarDate } from '../validation/calendar-date.js';
import { FieldErrorCode } from './error-codes.js';
import { AppException } from './app-exception.js';
import { fieldError } from '../validation/field-error.js';

/** A date in the path: `YYYY-MM-DD` and a real day, as `IsCalendarDate` says in a body; else 400 `INVALID_FORMAT` on `date`. */
@Injectable()
export class CalendarDateParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isCalendarDate(value)) {
      throw AppException.validation([fieldError('date', FieldErrorCode.INVALID_FORMAT)]);
    }
    return value;
  }
}
