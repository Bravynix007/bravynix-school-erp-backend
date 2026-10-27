import { HttpStatus } from '@nestjs/common';
import { BlockSectionName, type BlockSection } from '../auth/block-section.js';
import { ErrorCode } from './error-codes.js';

export interface FieldError {
  /** JSON path into the request, e.g. `marks[3].obtainedMarks`. */
  field: string;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

export interface AppExceptionOptions {
  /** Overrides the catalogue message for this code. Must be safe to show a user. */
  message?: string;
  errors?: FieldError[];
  /** Sent as the error's `data`, e.g. `attemptsLeft` or `reason`. */
  details?: Record<string, unknown>;
  /** Seconds; sets the `Retry-After` header (429, 423, 503). */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * The one exception type business code throws. The global filter turns it
 * into the standard error envelope (API design 8). Never put SQL, stack
 * traces, table names or another tenant's data in it.
 */
export class AppException extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: string,
    readonly options: AppExceptionOptions = {},
  ) {
    super(options.message ?? code, { cause: options.cause });
    this.name = 'AppException';
  }

  static validation(errors: FieldError[]): AppException {
    return new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, { errors });
  }

  static notFound(): AppException {
    return new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND);
  }

  static forbidden(code: string = ErrorCode.FORBIDDEN): AppException {
    return new AppException(HttpStatus.FORBIDDEN, code);
  }

  static unauthorized(
    code: string = ErrorCode.TOKEN_INVALID,
    details?: Record<string, unknown>,
  ): AppException {
    return new AppException(HttpStatus.UNAUTHORIZED, code, { details });
  }

  /** A block stops the caller's section (API design 6.5); `data.section` says which, the reason is not sent. */
  static sectionBlocked(section: BlockSection): AppException {
    return new AppException(HttpStatus.LOCKED, ErrorCode.SECTION_BLOCKED, {
      details: { section: BlockSectionName[section] },
    });
  }

  static conflict(code: string, message?: string): AppException {
    return new AppException(HttpStatus.CONFLICT, code, { message });
  }

  /** The record changed since the client read it; `data.currentVersion` says to what (API design 14.3). */
  static versionConflict(currentVersion: number): AppException {
    return new AppException(HttpStatus.CONFLICT, ErrorCode.VERSION_CONFLICT, {
      details: { currentVersion },
    });
  }

  static businessRule(code: string, message?: string): AppException {
    return new AppException(HttpStatus.UNPROCESSABLE_ENTITY, code, { message });
  }
}
