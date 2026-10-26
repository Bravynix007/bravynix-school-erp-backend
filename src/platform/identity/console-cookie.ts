import type { Request, Response } from 'express';
import { API_PREFIX } from '../../bootstrap/routes.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';

/** The console's refresh token, kept as a cookie script cannot read (API design 6.1). */
export const REFRESH_COOKIE = 'bnx_refresh';

/** The header the console adds to refresh and logout; a cross-site form cannot send it (API design 6.1). */
const CONSOLE_HEADER = 'x-requested-with';
const CONSOLE_HEADER_VALUE = 'bravynix-console';

export interface RefreshCookie {
  value: string;
  maxAgeSeconds: number;
}

/** Only the auth endpoints ever receive it. */
const COOKIE_PATH = `/${API_PREFIX}/auth`;

export function setRefreshCookie(res: Response, cookie: RefreshCookie): void {
  res.cookie(REFRESH_COOKIE, cookie.value, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: cookie.maxAgeSeconds * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
}

/** The refresh cookie's value, or undefined. Read from the header here because no other route needs cookies. */
export function readRefreshCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return rest.join('=') || undefined;
  }
  return undefined;
}

/** 403 `FORBIDDEN` unless the call carries the console header. */
export function requireConsoleHeader(req: Request): void {
  if (req.headers[CONSOLE_HEADER] !== CONSOLE_HEADER_VALUE) {
    throw AppException.forbidden(ErrorCode.FORBIDDEN);
  }
}
