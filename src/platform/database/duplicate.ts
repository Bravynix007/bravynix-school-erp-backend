import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { fieldError } from '../../common/validation/field-error.js';
import { PgErrorCode } from './database.service.js';

/** A unique-violation of the constraint or index whose name starts with `constraintPrefix`. */
export function isDuplicateOn(error: unknown, constraintPrefix: string): boolean {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return (
    code === PgErrorCode.uniqueViolation &&
    typeof constraint === 'string' &&
    constraint.startsWith(constraintPrefix)
  );
}

/** 409 `DUPLICATE`, naming the field that is already taken (API design 8). */
export function duplicateOn(field: string): AppException {
  return new AppException(HttpStatus.CONFLICT, ErrorCode.DUPLICATE, {
    errors: [fieldError(field, ErrorCode.DUPLICATE)],
  });
}
