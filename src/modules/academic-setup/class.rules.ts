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

/** The one category whose classes have streams (PRD 7.3; the stream of a Senior Secondary class is a section name). */
export const STREAM_CATEGORY = 'PRE_UNIVERSITY';

/** The longest name a class has (the column). */
const MAX_NAME = 60;

/** What the name of a class is when the request gives none: the predefined name, then the stream. */
export function defaultClassName(predefinedName: string, streamName: string | null): string {
  return streamName === null ? predefinedName : `${predefinedName} ${streamName}`;
}

/**
 * A class is made only in a category the Institution offers (422 `CLASS_NOT_OFFERED`, decision 24), and has a
 * stream only in Pre-University (422 `STREAM_NOT_ALLOWED`). `prefix` places the field in a bulk request.
 */
export function requireClassAllowed(
  category: { code: string; offered: boolean },
  streamName: string | null,
  prefix = '',
): void {
  if (!category.offered) {
    throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.CLASS_NOT_OFFERED, {
      errors: [fieldError(`${prefix}predefinedClassId`, ErrorCode.CLASS_NOT_OFFERED)],
    });
  }
  if (streamName !== null && category.code !== STREAM_CATEGORY) {
    throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.STREAM_NOT_ALLOWED, {
      errors: [fieldError(`${prefix}streamName`, ErrorCode.STREAM_NOT_ALLOWED)],
    });
  }
}

/** A name made of a predefined name and a stream can outgrow the column (400 `TOO_LONG`, naming the field). */
export function requireNameFits(name: string, prefix = ''): void {
  if (name.length > MAX_NAME) {
    throw AppException.validation([
      { ...fieldError(`${prefix}displayName`, FieldErrorCode.TOO_LONG), params: { max: MAX_NAME } },
    ]);
  }
}

/**
 * The database enforces what no race can break; a violation is the answer: the same predefined class and stream
 * twice is 409 `DUPLICATE` (on `streamName` when there is one, else on `predefinedClassId`), the same name 409
 * `DUPLICATE` on `displayName`, and a category unticked while the class was being made is `CLASS_NOT_OFFERED`.
 */
export function translateClassError(error: unknown, hasStream: boolean, prefix = ''): unknown {
  if (isDuplicateOn(error, 'uq_classes_institution_class_stream')) {
    return duplicateOn(`${prefix}${hasStream ? 'streamName' : 'predefinedClassId'}`);
  }
  if (isDuplicateOn(error, 'uq_classes_institution_name'))
    return duplicateOn(`${prefix}displayName`);
  if (isViolationOf(error, PgErrorCode.foreignKeyViolation, 'fk_classes_offered_category')) {
    return new AppException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.CLASS_NOT_OFFERED, {
      errors: [fieldError(`${prefix}predefinedClassId`, ErrorCode.CLASS_NOT_OFFERED)],
    });
  }
  return error;
}

/** The same for a section: a predefined section twice in a class is `DUPLICATE` on `predefinedSectionId`, a name on `displayName`. */
export function translateSectionError(error: unknown): unknown {
  if (isDuplicateOn(error, 'uq_sections_class_predefined'))
    return duplicateOn('predefinedSectionId');
  if (isDuplicateOn(error, 'uq_sections_class_name')) return duplicateOn('displayName');
  return error;
}
