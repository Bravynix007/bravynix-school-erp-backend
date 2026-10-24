import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/policy.guard.js';
import { RequestContext, type RequestContextData } from '../request-context/request-context.js';
import { CONTEXT_LOCAL } from '../request-context/request-id.middleware.js';

/** Header values are the client's own text; keep them short in the log. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value.slice(0, 20) : undefined;
}

/** The route Nest's Express adapter mounts under the global prefix to answer 404s. */
const NOT_FOUND_ROUTE = '*path';

/**
 * The route template (`/v1/students/:studentId`), never the filled path or
 * query, which can hold names, emails and phone numbers (API design 20.2).
 * Unmatched requests, including those Nest's 404 catch-all answers, have none.
 */
export function routeTemplate(req: IncomingMessage): string | undefined {
  const { route, baseUrl } = req as Request;
  const path: unknown = route?.path;
  if (typeof path !== 'string' || path === NOT_FOUND_ROUTE) return undefined;
  return `${baseUrl ?? ''}${path}`;
}

/** A path segment that reads as a word (`v1`, `wp-admin`); anything else may be data. */
const WORD = /^[a-z][a-z0-9-]{0,39}$/i;
const MAX_SEGMENTS = 6;

/**
 * The path of an unmatched request (a 404 or a scan), without its query and
 * with every segment that is not a plain word replaced by `:value`, so an
 * email, phone number or ID never reaches the log (SDD 17.1).
 */
export function sanitisedPath(req: IncomingMessage): string {
  // Express shortens req.url inside a mounted router; originalUrl is the full path.
  const url = (req as Partial<Request>).originalUrl ?? req.url ?? '';
  const [path = ''] = url.split('?');
  const segments = path.split('/').filter(Boolean);
  const shown = segments
    .slice(0, MAX_SEGMENTS)
    .map((segment) => (WORD.test(segment) ? segment : ':value'));
  if (segments.length > MAX_SEGMENTS) shown.push('…');
  return `/${shown.join('/')}`;
}

/** The request half of the log line: no URL, headers or body. */
export function serializeRequest(req: { id: string; method: string }): Record<string, unknown> {
  return { id: req.id, method: req.method };
}

/**
 * Fields added to the one log line written when the response finishes
 * (API design 20.2). pino-http asks at the start of the request too; the
 * route and code are not known then, so nothing is added and the line
 * carries each field once. The caller comes from the context kept on
 * `res.locals`, since `finish` can run outside the request's async context.
 */
export function requestLogProps(
  req: IncomingMessage,
  res: ServerResponse,
): Record<string, unknown> {
  if (!res.headersSent) return {};
  const locals = (res as Response).locals as Record<string, unknown> | undefined;
  const ctx =
    (locals?.[CONTEXT_LOCAL] as RequestContextData | undefined) ?? RequestContext.current();
  const route = routeTemplate(req);
  return {
    route,
    path: route ? undefined : sanitisedPath(req),
    code: locals?.['code'] as string | undefined,
    clientType: (req as AuthenticatedRequest).principal?.clientType,
    appPlatform: header(req, 'x-app-platform'),
    appVersion: header(req, 'x-app-version'),
    personId: ctx?.personId,
    societyId: ctx?.societyId,
    roleCode: ctx?.roleCode,
  };
}
