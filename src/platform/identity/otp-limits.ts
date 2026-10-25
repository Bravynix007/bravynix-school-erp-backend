import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/http/error-codes.js';
import { AuthCode } from './auth-codes.js';

/** The limits of API design 6.2 / PRD 5.1. All counted per email in the database. */
export const OTP_LIMITS = {
  /** Gap between two requests for one email. */
  resendGapSeconds: 60,
  /** Requests per email in the window. */
  requestsPerWindow: 3,
  requestWindowSeconds: 15 * 60,
  /** Code life. */
  codeLifeSeconds: 10 * 60,
  /** Wrong codes per code. */
  attemptsPerCode: 5,
  /** Failed logins in a row that lock an email, and for how long. */
  lockAfterFailures: 5,
  lockSeconds: 30 * 60,
  /** Unauthenticated requests per IP per minute (Proposed; tuned in the load test). */
  ipRequestsPerMinute: 20,
  ipWindowSeconds: 60,
} as const;

export interface OtpRequestFacts {
  now: Date;
  /** Request times from this IP in the last minute. */
  ipRequests: readonly Date[];
  /** Request times for this email in the last 15 minutes, newest first. */
  emailRequests: readonly Date[];
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
 * Decides whether a request for a login code is refused. Pure, and the same
 * for registered and unregistered emails, so no answer differs between them
 * (I-07). The first rule that applies wins: per-IP limit, lock, the 60-second
 * gap, then the 3-in-15-minutes limit.
 */
export function evaluateOtpRequest(facts: OtpRequestFacts): OtpRefusal | null {
  const { now } = facts;
  if (facts.ipRequests.length >= OTP_LIMITS.ipRequestsPerMinute) {
    const oldest = facts.ipRequests.reduce((a, b) => (a < b ? a : b));
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: ErrorCode.RATE_LIMITED,
      retryAfterSeconds: secondsUntil(plusSeconds(oldest, OTP_LIMITS.ipWindowSeconds), now),
    };
  }
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
  if (facts.emailRequests.length >= OTP_LIMITS.requestsPerWindow) {
    // The count drops below the limit when the third newest request leaves the window.
    const blocking = facts.emailRequests[OTP_LIMITS.requestsPerWindow - 1]!;
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: AuthCode.OTP_REQUEST_LIMIT,
      retryAfterSeconds: secondsUntil(plusSeconds(blocking, OTP_LIMITS.requestWindowSeconds), now),
    };
  }
  return null;
}
