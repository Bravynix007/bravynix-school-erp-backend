import type { Request, Response } from 'express';
import {
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE,
  requireConsoleHeader,
  setRefreshCookie,
} from './console-cookie.js';

const request = (headers: Record<string, string | undefined>) =>
  ({ headers }) as unknown as Request;

describe('console refresh cookie', () => {
  it('is HttpOnly, Secure, SameSite=Strict and sent only to the auth path', () => {
    const cookie = vi.fn<(...args: unknown[]) => void>();
    setRefreshCookie({ cookie } as unknown as Response, { value: 'rt_abc', maxAgeSeconds: 600 });
    expect(cookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'rt_abc', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/v1/auth',
      maxAge: 600_000,
    });
  });

  it('is cleared with the same attributes, or the browser would keep it', () => {
    const clearCookie = vi.fn<(...args: unknown[]) => void>();
    clearRefreshCookie({ clearCookie } as unknown as Response);
    expect(clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/v1/auth',
    });
  });

  it('is read by name from among other cookies, and an empty one is none', () => {
    expect(readRefreshCookie(request({ cookie: `a=1; ${REFRESH_COOKIE}=rt_x=y; b=2` }))).toBe(
      'rt_x=y',
    );
    expect(readRefreshCookie(request({ cookie: `a=1; b=2` }))).toBeUndefined();
    expect(readRefreshCookie(request({ cookie: `${REFRESH_COOKIE}=` }))).toBeUndefined();
    expect(readRefreshCookie(request({}))).toBeUndefined();
  });

  it('is not mistaken for a cookie whose name only ends the same way', () => {
    expect(readRefreshCookie(request({ cookie: `x${REFRESH_COOKIE}=rt_x` }))).toBeUndefined();
  });

  it('needs the console header with exactly its value', () => {
    expect(() =>
      requireConsoleHeader(request({ 'x-requested-with': 'bravynix-console' })),
    ).not.toThrow();
    for (const headers of [
      {},
      { 'x-requested-with': 'XMLHttpRequest' },
      { 'x-requested-with': '' },
    ]) {
      expect(() => requireConsoleHeader(request(headers))).toThrow('FORBIDDEN');
    }
  });
});
