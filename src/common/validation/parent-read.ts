import { FieldErrorCode } from '../http/error-codes.js';
import type { FieldError } from '../http/field-error.type.js';
import { fieldError } from './field-error.js';

/**
 * What is wrong with a parent's read query (API design 14.1): a parent names their child (`studentId`, 400 `REQUIRED`
 * without) and may name none of the fields in `forbidden`, which would widen the read past that child.
 */
export function parentReadErrors<Query extends { studentId?: string }>(
  query: Query,
  forbidden: readonly (keyof Query & string)[],
): FieldError[] {
  return [
    ...(query.studentId === undefined ? [fieldError('studentId', FieldErrorCode.REQUIRED)] : []),
    ...forbidden
      .filter((field) => query[field] !== undefined)
      .map((field) => fieldError(field, FieldErrorCode.FIELD_NOT_ALLOWED)),
  ];
}

/** Everyone but a parent has no child to name: `studentId` is 400 `FIELD_NOT_ALLOWED`. */
export function staffReadErrors(query: { studentId?: string }): FieldError[] {
  return query.studentId === undefined
    ? []
    : [fieldError('studentId', FieldErrorCode.FIELD_NOT_ALLOWED)];
}
