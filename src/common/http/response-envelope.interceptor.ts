import {
  HttpStatus,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import { message } from '../i18n/messages.js';
import { RequestContext } from '../request-context/request-context.js';
import { ApiResult, type ApiEnvelope } from './api-result.js';
import { ResultCode } from './error-codes.js';
import { RAW_RESPONSE } from './raw-response.decorator.js';

/**
 * Wraps every successful response in the standard envelope. The API never
 * sends 204: an operation with nothing to return answers 200 with
 * `data: null` (API design 7).
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();

    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(map((value: unknown) => this.wrap(value, response)));
  }

  private wrap(value: unknown, response: Response): ApiEnvelope {
    const ctx = RequestContext.current();
    const result = value instanceof ApiResult ? value : new ApiResult(value ?? null);
    const status =
      result.options.status ??
      (response.statusCode === HttpStatus.NO_CONTENT ? HttpStatus.OK : response.statusCode);
    response.status(status);
    if (!response.getHeader('Cache-Control')) response.setHeader('Cache-Control', 'no-store');
    const code = result.options.code ?? ResultCode.OK;
    return {
      success: true,
      statusCode: status,
      code,
      message: result.options.message ?? message(code, ctx?.language),
      data: (result.data ?? null) as unknown,
      meta: result.options.meta ?? null,
      requestId: ctx?.requestId ?? '',
    };
  }
}
