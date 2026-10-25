import type { NextFunction, Request, Response } from 'express';
import { isUuid, newId } from '../ids/ids.js';
import { resolveLanguage } from '../i18n/messages.js';
import { RequestContext, type RequestContextData } from './request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/** `res.locals` key holding the request context, for code that runs outside it. */
export const CONTEXT_LOCAL = 'requestContext';

/**
 * Gives every request an ID (the client's `X-Request-Id` when it is a UUID,
 * otherwise a new UUIDv7), echoes it in the response header, and opens the
 * request context for the rest of the call. Registered with `app.use` so it
 * runs before logging and every Nest component.
 *
 * The same context object is kept on `res.locals`: the request log line is
 * written on the response's `finish` event, which Node may run outside the
 * request's async context.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const requestId = isUuid(incoming) ? incoming : newId();
  (req as Request & { id: string }).id = requestId;
  res.setHeader('X-Request-Id', requestId);
  const context: RequestContextData = {
    requestId,
    language: resolveLanguage(req.header('accept-language')),
    ipAddress: req.ip,
    userAgent: req.header('user-agent'),
  };
  res.locals[CONTEXT_LOCAL] = context;
  RequestContext.run(context, () => next());
}
