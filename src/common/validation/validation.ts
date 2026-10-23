import {
  Injectable,
  ValidationPipe,
  type ArgumentMetadata,
  type PipeTransform,
  type ValidationError,
} from '@nestjs/common';
import { AppException, type FieldError } from '../http/app-exception.js';
import { FieldErrorCode } from '../http/error-codes.js';
import { message } from '../i18n/messages.js';
import { RequestContext } from '../request-context/request-context.js';

/** class-validator constraint name → field error code (API design 8). */
const CONSTRAINT_TO_CODE: Record<string, string> = {
  whitelistValidation: FieldErrorCode.FIELD_NOT_ALLOWED,
  isDefined: FieldErrorCode.REQUIRED,
  isNotEmpty: FieldErrorCode.REQUIRED,
  isString: FieldErrorCode.INVALID_TYPE,
  isInt: FieldErrorCode.INVALID_TYPE,
  isNumber: FieldErrorCode.INVALID_TYPE,
  isBoolean: FieldErrorCode.INVALID_TYPE,
  isArray: FieldErrorCode.INVALID_TYPE,
  isObject: FieldErrorCode.INVALID_TYPE,
  isUuid: FieldErrorCode.INVALID_FORMAT,
  isEmail: FieldErrorCode.INVALID_FORMAT,
  isDateString: FieldErrorCode.INVALID_FORMAT,
  isIso8601: FieldErrorCode.INVALID_FORMAT,
  matches: FieldErrorCode.INVALID_FORMAT,
  minLength: FieldErrorCode.TOO_SHORT,
  maxLength: FieldErrorCode.TOO_LONG,
  arrayMinSize: FieldErrorCode.TOO_SHORT,
  arrayMaxSize: FieldErrorCode.TOO_LONG,
  min: FieldErrorCode.OUT_OF_RANGE,
  max: FieldErrorCode.OUT_OF_RANGE,
  isIn: FieldErrorCode.INVALID_VALUE,
  isEnum: FieldErrorCode.INVALID_VALUE,
};

/** The order in which a field's failed constraints are reported; first wins. */
const PRIORITY = ['whitelistValidation', 'isDefined', 'isNotEmpty'];

export function toFieldErrors(errors: ValidationError[], parentPath = ''): FieldError[] {
  const language = RequestContext.current()?.language;
  const result: FieldError[] = [];
  for (const error of errors) {
    const isIndex = /^\d+$/.test(error.property);
    const path = parentPath
      ? isIndex
        ? `${parentPath}[${error.property}]`
        : `${parentPath}.${error.property}`
      : error.property;
    if (error.constraints) {
      const names = Object.keys(error.constraints);
      const first = PRIORITY.find((p) => names.includes(p)) ?? names[0];
      if (first) {
        const code =
          (error.contexts?.[first]?.['code'] as string | undefined) ??
          CONSTRAINT_TO_CODE[first] ??
          FieldErrorCode.INVALID_VALUE;
        result.push({ field: path, code, message: message(code, language) });
      }
    }
    if (error.children?.length) result.push(...toFieldErrors(error.children, path));
  }
  return result;
}

/**
 * The global validation pipe. Unknown fields are rejected, not ignored
 * (API design 7.4), which also stops clients from sending server-owned fields
 * such as `createdBy` or `status`.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => AppException.validation(toFieldErrors(errors)),
  });
}

function trimDeep(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(trimDeep);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimDeep(v)]));
  }
  return value;
}

/** Trims every string in the body and query before validation (API design 7.4). */
@Injectable()
export class TrimStringsPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === 'body' || metadata.type === 'query') return trimDeep(value);
    return value;
  }
}
