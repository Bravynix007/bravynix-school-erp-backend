import { Injectable, type PipeTransform } from '@nestjs/common';
import { FieldErrorCode } from './error-codes.js';
import { AppException } from './app-exception.js';
import { fieldError } from '../validation/field-error.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date in the path: `YYYY-MM-DD` and a real day, else 400 `INVALID_FORMAT` on `date` (API design 7.4). */
@Injectable()
export class CalendarDateParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const real =
      DATE.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!real) throw AppException.validation([fieldError('date', FieldErrorCode.INVALID_FORMAT)]);
    return value;
  }
}
