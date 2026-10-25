import type { NextFunction, Request, Response } from 'express';
import { RequestContext, type RequestContextData } from './request-context.js';
import { CONTEXT_LOCAL, requestIdMiddleware } from './request-id.middleware.js';

function run(headers: Record<string, string>, ip: string | undefined): RequestContextData {
  const req = {
    ip,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const res = { locals: {}, setHeader: () => undefined } as unknown as Response;
  let seen: RequestContextData | undefined;
  const next: NextFunction = () => {
    seen = RequestContext.current();
  };
  requestIdMiddleware(req, res, next);
  expect(seen).toBe((res.locals as Record<string, unknown>)[CONTEXT_LOCAL]);
  return seen!;
}

describe('requestIdMiddleware', () => {
  it('opens a context with the caller’s address and user agent, for the audit log', () => {
    const context = run({ 'user-agent': 'BravyNixApp/1.0' }, '203.0.113.7');
    expect(context).toMatchObject({ ipAddress: '203.0.113.7', userAgent: 'BravyNixApp/1.0' });
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('copes with a request that has neither', () => {
    const context = run({}, undefined);
    expect(context.ipAddress).toBeUndefined();
    expect(context.userAgent).toBeUndefined();
  });
});
