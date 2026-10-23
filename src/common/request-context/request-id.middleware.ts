import type { NextFunction, Request, Response } from 'express';
import { isUuid, newId } from '../ids/ids.js';
import { resolveLanguage } from '../i18n/messages.js';
import { RequestContext } from './request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Gives every request an ID (the client's `X-Request-Id` when it is a UUID,
 * otherwise a new UUIDv7), echoes it in the response header, and opens the
 * request context for the rest of the call. Registered with `app.use` so it
 * runs before logging and every Nest component.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const requestId = isUuid(incoming) ? incoming : newId();
  (req as Request & { id: string }).id = requestId;
  res.setHeader('X-Request-Id', requestId);
  RequestContext.run({ requestId, language: resolveLanguage(req.header('accept-language')) }, () =>
    next(),
  );
}
