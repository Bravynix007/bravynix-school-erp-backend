import { HttpStatus } from '@nestjs/common';
import express, { type RequestHandler } from 'express';
import { AppException } from './app-exception.js';
import { ErrorCode } from './error-codes.js';

/** Errors body-parser raises, by their `type` (see the body-parser README). */
const PARSER_ERRORS: Record<string, [HttpStatus, string]> = {
  'entity.parse.failed': [HttpStatus.BAD_REQUEST, ErrorCode.MALFORMED_JSON],
  'entity.too.large': [HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.PAYLOAD_TOO_LARGE],
  'charset.unsupported': [HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE],
  'encoding.unsupported': [HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE],
  'request.aborted': [HttpStatus.BAD_REQUEST, ErrorCode.MALFORMED_JSON],
};

/**
 * Parses JSON bodies up to `limit` (1 MB, API design 7.4) and turns parser
 * failures into `AppException`s, so they reach the global filter with their
 * own codes instead of a generic 400.
 */
export function jsonBodyMiddleware(limit: string): RequestHandler {
  const parse = express.json({ limit, strict: true });
  return (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      if (!error) return next();
      const type = (error as { type?: string }).type ?? '';
      const [status, code] = PARSER_ERRORS[type] ?? [
        HttpStatus.BAD_REQUEST,
        ErrorCode.MALFORMED_JSON,
      ];
      next(new AppException(status, code, { cause: error }));
    });
  };
}
