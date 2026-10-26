import { HttpStatus } from '@nestjs/common';
import { evaluateIpLimit, evaluateOtpRequest } from './otp-limits.js';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const base = { now: NOW, emailRequests: [], addressRequests: [], lockedUntil: null };

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

  it('refuses a fourth request from one address in 15 minutes, until the third newest leaves the window', () => {
    const own = [ago(120), ago(300), ago(600)];
    expect(evaluateOtpRequest({ ...base, emailRequests: own, addressRequests: own })).toEqual({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'OTP_REQUEST_LIMIT',
      retryAfterSeconds: 300,
    });
  });

  it('counts only requests inside the window (the caller passes those)', () => {
    const own = [ago(120), ago(300)];
    expect(evaluateOtpRequest({ ...base, emailRequests: own, addressRequests: own })).toBeNull();
  });

  it('does not let requests from other addresses use up this address’s three', () => {
    const others = [ago(120), ago(300), ago(600), ago(700)];
    expect(evaluateOtpRequest({ ...base, emailRequests: others })).toBeNull();
  });

  it('refuses the eleventh request for an email from all addresses together, until the tenth newest leaves', () => {
    const all = Array.from({ length: 10 }, (_, i) => ago(100 + i * 80));
    expect(evaluateOtpRequest({ ...base, emailRequests: all })).toEqual({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'OTP_REQUEST_LIMIT',
      retryAfterSeconds: 900 - 820,
    });
    expect(evaluateOtpRequest({ ...base, emailRequests: all.slice(0, 9) })).toBeNull();
  });

  it('keeps the 60-second gap across addresses', () => {
    expect(evaluateOtpRequest({ ...base, emailRequests: [ago(10)] })?.code).toBe(
      'OTP_RESEND_TOO_SOON',
    );
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

describe('evaluateIpLimit', () => {
  const windowStart = new Date('2026-10-25T10:00:00.000Z');
  const at = (seconds: number) => new Date(windowStart.getTime() + seconds * 1000);

  it('allows 20 calls in a window, the current one included', () => {
    expect(evaluateIpLimit(at(10), windowStart, 1)).toBeNull();
    expect(evaluateIpLimit(at(10), windowStart, 20)).toBeNull();
  });

  it('refuses the 21st until the window ends', () => {
    expect(evaluateIpLimit(at(25), windowStart, 21)).toEqual({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 35,
    });
  });

  it('never says less than one second', () => {
    expect(
      evaluateIpLimit(new Date(windowStart.getTime() + 59_999), windowStart, 99)?.retryAfterSeconds,
    ).toBe(1);
  });
});
