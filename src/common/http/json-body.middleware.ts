import { HttpStatus } from '@nestjs/common';
import express, { type RequestHandler } from 'express';
import { AppException } from './app-exception.js';
import { ErrorCode } from './error-codes.js';
import { isNonUtf8Json, parseMediaType } from './media-type.js';

/** Errors body-parser raises, by their `type` (see the body-parser README). */
const PARSER_ERRORS: Record<string, [HttpStatus, string]> = {
  'entity.parse.failed': [HttpStatus.BAD_REQUEST, ErrorCode.MALFORMED_JSON],
  'entity.too.large': [HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.PAYLOAD_TOO_LARGE],
  'charset.unsupported': [HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE],
  'encoding.unsupported': [HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE],
  'request.aborted': [HttpStatus.BAD_REQUEST, ErrorCode.MALFORMED_JSON],
  'entity.too.deep': [HttpStatus.BAD_REQUEST, ErrorCode.MALFORMED_JSON],
};

/** No request needs more; deeper bodies only exhaust the stack (API design 7.4). */
export const MAX_JSON_DEPTH = 32;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPENERS = new Set([0x5b, 0x7b]);
const CLOSERS = new Set([0x5d, 0x7d]);

/**
 * Whether raw JSON nests arrays and objects deeper than `max`, found by one
 * pass over the bytes before parsing. UTF-8 continuation bytes are all 0x80 or
 * above, so a quote, backslash or bracket byte is always that character.
 */
export function nestsDeeperThan(body: Uint8Array, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const byte = body[i]!;
    if (inString) {
      if (byte === BACKSLASH) i += 1;
      else if (byte === QUOTE) inString = false;
    } else if (byte === QUOTE) {
      inString = true;
    } else if (OPENERS.has(byte)) {
      depth += 1;
      if (depth > max) return true;
    } else if (CLOSERS.has(byte)) {
      depth -= 1;
    }
  }
  return false;
}

/**
 * Parses JSON bodies up to `limit` (1 MB) and `MAX_JSON_DEPTH` levels
 * (API design 7.4), and turns parser failures into `AppException`s, so they
 * reach the global filter with their own codes instead of a generic 400.
 * JSON in any charset but UTF-8 is refused before parsing (API design 7.2):
 * body-parser would decode `utf-16`, and the depth scan reads UTF-8 bytes.
 */
export function jsonBodyMiddleware(limit: string): RequestHandler {
  const parse = express.json({
    limit,
    strict: true,
    verify: (_req, _res, body) => {
      if (nestsDeeperThan(body, MAX_JSON_DEPTH)) {
        throw Object.assign(new Error('JSON nested too deeply'), { type: 'entity.too.deep' });
      }
    },
  });
  return (req, res, next) => {
    if (isNonUtf8Json(parseMediaType(req.header('content-type')))) {
      next(new AppException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE));
      return;
    }
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
