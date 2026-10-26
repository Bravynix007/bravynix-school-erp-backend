import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/http/error-codes.js';
import { AuthCode } from './auth-codes.js';

/** The limits of API design 6.2 / PRD 5.1. All counted per email in the database. */
export const OTP_LIMITS = {
  /** Gap between two requests for one email. */
  resendGapSeconds: 60,
  /** Requests per email from one address in the window. */
  requestsPerAddressPerWindow: 3,
  /** Requests per email from all addresses in the window, so a stranger cannot use up the person's turns. */
  requestsPerEmailPerWindow: 10,
  requestWindowSeconds: 15 * 60,
  /** Code life. */
  codeLifeSeconds: 10 * 60,
  /** Wrong codes per code. */
  attemptsPerCode: 5,
  /** Failed logins in a row that lock an email, and for how long. */
  lockAfterFailures: 5,
  lockSeconds: 30 * 60,
  /** The lockouts within the window that make the next one a long lock (PRD 5.1). */
  lockoutsBeforeLongLock: 3,
  lockoutWindowSeconds: 24 * 3600,
  longLockSeconds: 24 * 3600,
  /** Unauthenticated requests per IP per minute (Proposed; tuned in the load test). */
  ipRequestsPerMinute: 20,
  ipWindowSeconds: 60,
  /** Refresh per IP per minute (Proposed; tuned in the load test). Higher: people share school and carrier addresses, and a refresh token cannot be guessed. */
  refreshRequestsPerMinute: 300,
} as const;

/**
 * How long a lockout lasts, given how many lockouts the email has had in the
 * last 24 hours including this one: 30 minutes, and 24 hours from the third.
 */
export function lockSecondsFor(lockoutsInWindow: number): number {
  return lockoutsInWindow >= OTP_LIMITS.lockoutsBeforeLongLock
    ? OTP_LIMITS.longLockSeconds
    : OTP_LIMITS.lockSeconds;
}

export interface OtpRequestFacts {
  now: Date;
  /** Request times for this email in the last 15 minutes from any address, newest first. */
  emailRequests: readonly Date[];
  /** The same, from the address making this request only. */
  addressRequests: readonly Date[];
  /** The end of the longest active lock on this email, if any. */
  lockedUntil: Date | null;
}

export interface OtpRefusal {
  status: HttpStatus;
  code: string;
  retryAfterSeconds: number;
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

function plusSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

/**
 * The per-IP limit on public calls (API design 18.1). `calls` is the count
 * for this IP in the current one-minute window, including the current call
 * and calls refused for other reasons: a refused call still costs work. The
 * 21st is refused until the window ends. Fixed windows allow up to twice the
 * limit across a boundary, which the "Proposed" value accepts.
 */
export function evaluateIpLimit(
  now: Date,
  windowStart: Date,
  calls: number,
  limit: number = OTP_LIMITS.ipRequestsPerMinute,
): OtpRefusal | null {
  if (calls <= limit) return null;
  return {
    status: HttpStatus.TOO_MANY_REQUESTS,
    code: ErrorCode.RATE_LIMITED,
    retryAfterSeconds: secondsUntil(plusSeconds(windowStart, OTP_LIMITS.ipWindowSeconds), now),
  };
}

/**
 * Decides whether a request for a login code is refused. Pure, and the same
 * for registered and unregistered emails, so no answer differs between them
 * (I-07). The first rule that applies wins: lock, the 60-second gap,
 * 3 in 15 minutes from one address, then 10 in 15 minutes from all addresses. The per-IP limit runs earlier, on every public call
 * (`evaluateIpLimit`).
 */
export function evaluateOtpRequest(facts: OtpRequestFacts): OtpRefusal | null {
  const { now } = facts;
  if (facts.lockedUntil && facts.lockedUntil > now) {
    return {
      status: HttpStatus.LOCKED,
      code: AuthCode.AUTH_LOCKED,
      retryAfterSeconds: secondsUntil(facts.lockedUntil, now),
    };
  }
  const newest = facts.emailRequests[0];
  if (newest) {
    const gapEnds = plusSeconds(newest, OTP_LIMITS.resendGapSeconds);
    if (gapEnds > now) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: AuthCode.OTP_RESEND_TOO_SOON,
        retryAfterSeconds: secondsUntil(gapEnds, now),
      };
    }
  }
  // The count drops below a limit when its newest-but-N request leaves the window.
  const own = facts.addressRequests;
  if (own.length >= OTP_LIMITS.requestsPerAddressPerWindow) {
    const blocking = own[OTP_LIMITS.requestsPerAddressPerWindow - 1]!;
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: AuthCode.OTP_REQUEST_LIMIT,
      retryAfterSeconds: secondsUntil(plusSeconds(blocking, OTP_LIMITS.requestWindowSeconds), now),
    };
  }
  if (facts.emailRequests.length >= OTP_LIMITS.requestsPerEmailPerWindow) {
    const blocking = facts.emailRequests[OTP_LIMITS.requestsPerEmailPerWindow - 1]!;
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: AuthCode.OTP_REQUEST_LIMIT,
      retryAfterSeconds: secondsUntil(plusSeconds(blocking, OTP_LIMITS.requestWindowSeconds), now),
    };
  }
  return null;
}
