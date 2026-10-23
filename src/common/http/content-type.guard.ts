import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from './app-exception.js';
import { ErrorCode } from './error-codes.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function hasBody(request: Request): boolean {
  const length = Number(request.header('content-length') ?? 0);
  return length > 0 || request.header('transfer-encoding') !== undefined;
}

/**
 * Request bodies must be UTF-8 JSON (API design 7.2); anything else is
 * 415 UNSUPPORTED_MEDIA_TYPE. Files never travel in JSON bodies (section 15).
 */
@Injectable()
export class ContentTypeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (!BODY_METHODS.has(request.method) || !hasBody(request)) return true;

    const contentType = (request.header('content-type') ?? '').toLowerCase();
    const [mime, ...params] = contentType.split(';').map((part) => part.trim());
    const charset = params
      .find((p) => p.startsWith('charset='))
      ?.slice('charset='.length)
      .replace(/^"(.*)"$/, '$1');
    // body-parser has already unquoted the charset and refused anything not
    // `utf-*` (so `utf8` is a 415 there); this narrows it to UTF-8 alone.
    if (mime !== 'application/json' || (charset && charset !== 'utf-8')) {
      throw new AppException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE);
    }
    return true;
  }
}
