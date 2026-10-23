import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { message } from '../i18n/messages.js';
import { RequestContext } from '../request-context/request-context.js';
import type { ApiEnvelope } from './api-result.js';
import { AppException, type FieldError } from './app-exception.js';
import { ErrorCode } from './error-codes.js';

interface NormalisedError {
  status: number;
  code: string;
  message?: string;
  errors?: FieldError[];
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

const STATUS_TO_CODE: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.TOKEN_INVALID,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.DUPLICATE,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

/**
 * Turns every thrown error into the standard error envelope (API design 8).
 * Unknown errors become 500 INTERNAL_ERROR with nothing internal in the body;
 * the full error goes to the log with the request ID.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const normalised = this.normalise(exception);

    if (normalised.status >= 500) {
      this.logger.error(
        { err: exception, requestId: RequestContext.requestId() },
        'Unhandled error',
      );
    }

    const ctx = RequestContext.current();
    const body: ApiEnvelope = {
      success: false,
      statusCode: normalised.status,
      code: normalised.code,
      message: normalised.message ?? message(normalised.code, ctx?.language),
      data: null,
      meta: null,
      ...(normalised.errors?.length ? { errors: normalised.errors } : {}),
      ...normalised.details,
      requestId: ctx?.requestId ?? '',
    };

    if (normalised.retryAfterSeconds !== undefined) {
      response.setHeader(
        'Retry-After',
        String(Math.max(0, Math.ceil(normalised.retryAfterSeconds))),
      );
    }
    response.setHeader('Cache-Control', 'no-store');
    response.status(normalised.status).json(body);
  }

  private normalise(exception: unknown): NormalisedError {
    if (exception instanceof AppException) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.options.message,
        errors: exception.options.errors,
        details: exception.options.details,
        retryAfterSeconds: exception.options.retryAfterSeconds,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code:
          STATUS_TO_CODE[status] ??
          (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.VALIDATION_FAILED),
      };
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: ErrorCode.INTERNAL_ERROR };
  }
}
