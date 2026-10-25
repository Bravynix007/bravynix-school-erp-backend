import { HttpStatus } from '@nestjs/common';
import { evaluateOtpRequest, OTP_LIMITS } from './otp-limits.js';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const base = { now: NOW, ipRequests: [], emailRequests: [], lockedUntil: null };

describe('evaluateOtpRequest', () => {
  it('lets a first request through', () => {
    expect(evaluateOtpRequest(base)).toBeNull();
  });

  it('refuses a second request within 60 seconds, with the seconds left', () => {
    expect(evaluateOtpRequest({ ...base, emailRequests: [ago(20)] })).toEqual({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'OTP_RESEND_TOO_SOON',
      retryAfterSeconds: 40,
    });
  });

  it('allows exactly 60 seconds later', () => {
    expect(evaluateOtpRequest({ ...base, emailRequests: [ago(60)] })).toBeNull();
  });

  it('refuses a fourth request in 15 minutes, until the third newest leaves the window', () => {
    const emailRequests = [ago(120), ago(300), ago(600)];
    expect(evaluateOtpRequest({ ...base, emailRequests })).toEqual({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'OTP_REQUEST_LIMIT',
      retryAfterSeconds: 300,
    });
  });

  it('counts only requests inside the window (the caller passes those)', () => {
    expect(evaluateOtpRequest({ ...base, emailRequests: [ago(120), ago(300)] })).toBeNull();
  });

  it('refuses a locked email with the time left, before the other email rules', () => {
    const lockedUntil = new Date(NOW.getTime() + 1500 * 1000);
    expect(evaluateOtpRequest({ ...base, lockedUntil, emailRequests: [ago(10)] })).toEqual({
      status: HttpStatus.LOCKED,
      code: 'AUTH_LOCKED',
      retryAfterSeconds: 1500,
    });
  });

  it('ignores a lock that has ended', () => {
    expect(evaluateOtpRequest({ ...base, lockedUntil: ago(1) })).toBeNull();
  });

  it('refuses the 21st request from one IP in a minute, before everything else', () => {
    const ipRequests = Array.from({ length: OTP_LIMITS.ipRequestsPerMinute }, (_, i) =>
      ago(50 - i),
    );
    expect(
      evaluateOtpRequest({
        ...base,
        ipRequests,
        lockedUntil: new Date(NOW.getTime() + 60_000),
      }),
    ).toEqual({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 10,
    });
  });

  it('allows 19 requests from one IP', () => {
    const ipRequests = Array.from({ length: 19 }, () => ago(5));
    expect(evaluateOtpRequest({ ...base, ipRequests })).toBeNull();
  });

  it('never says less than one second', () => {
    const refusal = evaluateOtpRequest({
      ...base,
      emailRequests: [new Date(NOW.getTime() - 59_999)],
    });
    expect(refusal?.retryAfterSeconds).toBe(1);
  });
});
