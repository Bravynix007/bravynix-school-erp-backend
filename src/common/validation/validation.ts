import {
  Injectable,
  ValidationPipe,
  type ArgumentMetadata,
  type PipeTransform,
  type ValidationError,
} from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';
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
  isPositive: FieldErrorCode.OUT_OF_RANGE,
  isNegative: FieldErrorCode.OUT_OF_RANGE,
  minDate: FieldErrorCode.OUT_OF_RANGE,
  maxDate: FieldErrorCode.OUT_OF_RANGE,
  isDate: FieldErrorCode.INVALID_FORMAT,
  isUrl: FieldErrorCode.INVALID_FORMAT,
  isPhoneNumber: FieldErrorCode.INVALID_FORMAT,
  isMobilePhone: FieldErrorCode.INVALID_FORMAT,
  isNumberString: FieldErrorCode.INVALID_FORMAT,
  isDecimal: FieldErrorCode.INVALID_FORMAT,
  arrayNotEmpty: FieldErrorCode.REQUIRED,
  arrayUnique: FieldErrorCode.INVALID_VALUE,
  arrayMinSize: FieldErrorCode.TOO_FEW,
  arrayMaxSize: FieldErrorCode.TOO_MANY,
  min: FieldErrorCode.OUT_OF_RANGE,
  max: FieldErrorCode.OUT_OF_RANGE,
  // Code-list fields (API design 12.1).
  isIn: FieldErrorCode.INVALID_CODE,
  isEnum: FieldErrorCode.INVALID_CODE,
};

/**
 * `@Length(min, max)` reports one constraint for both ends; class-validator's
 * message says which end failed ("longer than" means the value is too short).
 */
function lengthCode(constraint: string, text: string | undefined): string | undefined {
  if (constraint !== 'isLength') return undefined;
  return text?.includes('longer than') ? FieldErrorCode.TOO_SHORT : FieldErrorCode.TOO_LONG;
}

/**
 * The order in which a field's failed constraints are reported; first wins.
 * A wrong type comes straight after a missing value, so `{"name": 123}` is
 * INVALID_TYPE rather than whichever length rule happened to fail too.
 */
const PRIORITY = [
  'whitelistValidation',
  'isDefined',
  'isNotEmpty',
  'isString',
  'isInt',
  'isNumber',
  'isBoolean',
  'isArray',
  'isObject',
];

/** The limit a failed constraint carries, as `params` (API design 8, 12.1). */
const PARAMS: Record<string, (args: unknown[], code: string) => Record<string, unknown>> = {
  minLength: ([min]) => ({ min }),
  maxLength: ([max]) => ({ max }),
  isLength: ([min, max], code) =>
    code === FieldErrorCode.TOO_SHORT ? { min } : max === undefined ? {} : { max },
  min: ([min]) => ({ min }),
  max: ([max]) => ({ max }),
  arrayMinSize: ([min]) => ({ min }),
  arrayMaxSize: ([max]) => ({ max }),
};

/** Looks up the arguments a decorator was given, e.g. 20 for `@MaxLength(20)`. */
function constraintArgs(error: ValidationError, name: string): unknown[] | undefined {
  const target: unknown = error.target;
  if (!target || typeof target !== 'object') return undefined;
  return getMetadataStorage()
    .getTargetValidationMetadatas(target.constructor, '', true, false)
    .find((meta) => meta.propertyName === error.property && meta.name === name)?.constraints;
}

function paramsFor(error: ValidationError, name: string, code: string) {
  const build = PARAMS[name];
  const args = build && constraintArgs(error, name);
  if (!build || !args) return undefined;
  const params = build(args, code);
  return Object.keys(params).length ? params : undefined;
}

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
          lengthCode(first, error.constraints[first]) ??
          CONSTRAINT_TO_CODE[first] ??
          FieldErrorCode.INVALID_VALUE;
        const params = paramsFor(error, first, code);
        result.push({
          field: path,
          code,
          message: message(code, language),
          ...(params ? { params } : {}),
        });
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
    // The target is kept only to look up a constraint's limit for `params`;
    // values never reach the error (they may be personal data).
    validationError: { target: true, value: false },
    exceptionFactory: (errors) => AppException.validation(toFieldErrors(errors)),
  });
}

/** Keys JSON.parse keeps but class-transformer drops without a word; refused like any unknown field. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  // Express 5 builds req.query with a null prototype, so both kinds count.
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function trimDeep(value: unknown, path: string, refused: string[]): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item, i) => trimDeep(item, `${path}[${i}]`, refused));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const at = path ? `${path}.${key}` : key;
        if (RESERVED_KEYS.has(key)) refused.push(at);
        return [key, trimDeep(item, at, refused)];
      }),
    );
  }
  return value;
}

/**
 * Trims every string in the body and query before validation, and refuses
 * `__proto__`, `constructor` and `prototype` keys (API design 7.4).
 */
@Injectable()
export class TrimStringsPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' && metadata.type !== 'query') return value;
    const refused: string[] = [];
    const trimmed = trimDeep(value, '', refused);
    if (refused.length) {
      const language = RequestContext.current()?.language;
      const code = FieldErrorCode.FIELD_NOT_ALLOWED;
      throw AppException.validation(
        refused.map((field) => ({ field, code, message: message(code, language) })),
      );
    }
    return trimmed;
  }
}
