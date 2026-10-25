import { HttpStatus } from '@nestjs/common';
import { evaluateIpLimit, evaluateOtpRequest } from './otp-limits.js';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const base = { now: NOW, emailRequests: [], lockedUntil: null };

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

  it('never says less than one second', () => {
    const refusal = evaluateOtpRequest({
      ...base,
      emailRequests: [new Date(NOW.getTime() - 59_999)],
    });
    expect(refusal?.retryAfterSeconds).toBe(1);
  });
});

const hits = (count: number) => Array.from({ length: count }, (_, i) => ago(50 - i));

describe('evaluateIpLimit', () => {
  it('allows 20 calls in a minute, the current one included', () => {
    expect(evaluateIpLimit(NOW, hits(20))).toBeNull();
    expect(evaluateIpLimit(NOW, [])).toBeNull();
  });

  it('refuses the 21st, until the oldest call leaves the minute', () => {
    expect(evaluateIpLimit(NOW, hits(21))).toEqual({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 10,
    });
  });

  it('waits for as many calls to leave as are over the limit', () => {
    // 23 calls: three must leave before the count is back at 20, so wait for the third oldest.
    expect(evaluateIpLimit(NOW, hits(23))?.retryAfterSeconds).toBe(12);
  });

  it('never says less than one second', () => {
    const edge = [new Date(NOW.getTime() - 59_999), ...Array.from({ length: 20 }, () => NOW)];
    expect(evaluateIpLimit(NOW, edge)?.retryAfterSeconds).toBe(1);
  });
});
