import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/policy.guard.js';
import { RequestContext } from '../request-context/request-context.js';

/** Header values are the client's own text; keep them short in the log. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value.slice(0, 20) : undefined;
}

/**
 * The route template (`/v1/students/:studentId`), never the filled path or
 * query, which can hold names, emails and phone numbers (API design 20.2).
 * Unmatched requests have no template and log none.
 */
export function routeTemplate(req: IncomingMessage): string | undefined {
  const { route, baseUrl } = req as Request;
  const path: unknown = route?.path;
  return typeof path === 'string' ? `${baseUrl ?? ''}${path}` : undefined;
}

/** The request half of the log line: no URL, headers or body. */
export function serializeRequest(req: { id: string; method: string }): Record<string, unknown> {
  return { id: req.id, method: req.method };
}

/**
 * Fields added to the one log line written when the response finishes
 * (API design 20.2). Before then the route and code are not known, so
 * nothing is added and the line carries each field once.
 */
export function requestLogProps(
  req: IncomingMessage,
  res: ServerResponse,
): Record<string, unknown> {
  if (!res.headersSent) return {};
  const ctx = RequestContext.current();
  return {
    route: routeTemplate(req),
    code: (res as Response).locals?.['code'] as string | undefined,
    clientType: (req as AuthenticatedRequest).principal?.clientType,
    appPlatform: header(req, 'x-app-platform'),
    appVersion: header(req, 'x-app-version'),
    personId: ctx?.personId,
    societyId: ctx?.societyId,
    roleCode: ctx?.roleCode,
  };
}
