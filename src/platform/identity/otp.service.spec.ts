import { Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { RequestContext } from '../../common/request-context/request-context.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AppConfig } from '../../config/app-config.js';
import type { DatabaseService } from '../database/index.js';
import type { EmailSender } from '../email/email-sender.js';
import { AccountStatus, AuthCode, ClientType } from './auth-codes.js';
import type { IdentityRepository, LoginUser, NewChallenge } from './identity.repository.js';
import { OtpHasher } from './otp-hasher.js';
import { OtpService } from './otp.service.js';
import type { PublicCallLimiter } from './public-call-limiter.js';

/** Rules of AUTH-01 with the database and mail replaced; the SQL itself is covered by the integration tests. */
const EMAIL = 'asha@two-worlds.test';
const user = (patch: Partial<LoginUser> = {}): LoginUser => ({
  id: '0192b0e0-0000-7000-8000-000000000001',
  email: EMAIL,
  firstName: 'Asha',
  lastName: 'Rao',
  accountStatus: AccountStatus.Active as number,
  preferredLanguage: 'en',
  lockedUntil: null,
  ...patch,
});

function build(
  options: { user?: LoginUser; superAdmin?: boolean; devEcho?: boolean; lockBusy?: boolean } = {},
) {
  const stored: NewChallenge[] = [];
  const times = {
    email: [] as { at: Date; sameAddress: boolean }[],
    lock: null as Date | null,
  };
  const repository = {
    tryLockEmail: vi.fn<IdentityRepository['tryLockEmail']>(async () => !options.lockBusy),
    findUserByEmail: vi.fn<IdentityRepository['findUserByEmail']>(async () => options.user),
    emailRequestTimes: vi.fn<IdentityRepository['emailRequestTimes']>(async () => times.email),
    activeChallengeLock: vi.fn<IdentityRepository['activeChallengeLock']>(async () => times.lock),
    hasActiveSuperAdminGrant: vi.fn<IdentityRepository['hasActiveSuperAdminGrant']>(
      async () => options.superAdmin ?? false,
    ),
    supersedeLive: vi.fn<IdentityRepository['supersedeLive']>(async () => undefined),
    insertChallenge: vi.fn<IdentityRepository['insertChallenge']>(
      async (_tx: unknown, row: NewChallenge) => {
        stored.push(row);
      },
    ),
  };
  const check = vi.fn<PublicCallLimiter['check']>(async () => undefined);
  const send = vi.fn<EmailSender['send']>(async () => undefined);
  const clock = new FixedClock();
  const service = new OtpService(
    {
      transaction: (_tenant: unknown, work: (tx: unknown) => unknown) => work({}),
    } as DatabaseService,
    repository as unknown as IdentityRepository,
    clock,
    { env: { OTP_DEV_ECHO: options.devEcho ?? false } } as AppConfig,
    { send } as unknown as EmailSender,
    new OtpHasher('a'.repeat(32)),
    { check } as unknown as PublicCallLimiter,
  );
  return { service, repository, stored, times, send, clock, check };
}

const request = (clientType: ClientType = ClientType.Mobile, email = EMAIL) => ({
  email,
  clientType,
});

const ipSeen = async (ipAddress: string | undefined) => {
  const t = build({ user: user() });
  await RequestContext.run({ requestId: 'r1', language: 'en', ipAddress }, () =>
    t.service.requestCode(request()),
  );
  return t.stored[0]?.requestIp;
};

describe('OtpService.requestCode', () => {
  it('stores a code and sends the mail for an account that can sign in', async () => {
    const t = build({ user: user() });
    await t.service.requestCode(request());
    await t.service.flush();
    expect(t.stored).toHaveLength(1);
    expect(t.stored[0]?.userId).not.toBeNull();
    expect(t.stored[0]?.codeHmac).toHaveLength(32);
    expect(t.send).toHaveBeenCalledOnce();
  });

  it('stores a row without a code for an unknown email and sends nothing', async () => {
    const t = build();
    expect(await t.service.requestCode(request())).toEqual({});
    await t.service.flush();
    expect(t.stored).toHaveLength(1);
    expect(t.stored[0]).toMatchObject({ userId: null, codeHmac: null });
    expect(t.send).not.toHaveBeenCalled();
  });

  it('sends nothing to an Inactive account', async () => {
    const t = build({ user: user({ accountStatus: AccountStatus.Inactive }) });
    await t.service.requestCode(request());
    await t.service.flush();
    expect(t.stored[0]?.codeHmac).toBeNull();
    expect(t.send).not.toHaveBeenCalled();
  });

  it('gives Pending and Blocked accounts a code, so the answer does not reveal the state', async () => {
    for (const accountStatus of [AccountStatus.Pending, AccountStatus.Blocked]) {
      const t = build({ user: user({ accountStatus }) });
      await t.service.requestCode(request());
      await t.service.flush();
      expect(t.send).toHaveBeenCalledOnce();
    }
  });

  it('sends the console only to a Super Admin', async () => {
    const plain = build({ user: user(), superAdmin: false });
    await plain.service.requestCode(request(ClientType.Console));
    await plain.service.flush();
    expect(plain.send).not.toHaveBeenCalled();
    expect(plain.stored[0]?.codeHmac).toBeNull();

    const admin = build({ user: user(), superAdmin: true });
    await admin.service.requestCode(request(ClientType.Console));
    await admin.service.flush();
    expect(admin.send).toHaveBeenCalledOnce();
  });

  it('looks up the grant for every console request, with a nil id when there is no account', async () => {
    const t = build();
    await t.service.requestCode(request(ClientType.Console));
    expect(t.repository.hasActiveSuperAdminGrant).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000000',
    );
    expect(t.stored[0]?.codeHmac).toBeNull();
  });

  it('does not look up a grant for the mobile app', async () => {
    const t = build({ user: user() });
    await t.service.requestCode(request(ClientType.Mobile));
    expect(t.repository.hasActiveSuperAdminGrant).not.toHaveBeenCalled();
  });

  it('normalises the address before hashing, looking up and mailing', async () => {
    const t = build({ user: user() });
    await t.service.requestCode(request(ClientType.Mobile, `  ${EMAIL.toUpperCase()} `));
    await t.service.flush();
    expect(t.repository.findUserByEmail).toHaveBeenCalledWith(expect.anything(), EMAIL);
    expect(t.stored[0]?.emailHmac.equals(new OtpHasher('a'.repeat(32)).email(EMAIL))).toBe(true);
  });

  it('echoes the code only when development echo is on and an account received one', async () => {
    const on = build({ user: user(), devEcho: true });
    expect((await on.service.requestCode(request())).devCode).toMatch(/^\d{6}$/);
    const unknown = build({ devEcho: true });
    expect(await unknown.service.requestCode(request())).toEqual({});
    const off = build({ user: user(), devEcho: false });
    expect(await off.service.requestCode(request())).toEqual({});
  });

  it('stamps the challenge with the clock and a ten-minute life', async () => {
    const t = build({ user: user() });
    await t.service.requestCode(request());
    const row = t.stored[0]!;
    expect(row.createdAt).toEqual(t.clock.now());
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(600_000);
  });

  describe('refusals', () => {
    it('refuses inside the 60-second gap, with Retry-After, and stores nothing', async () => {
      const t = build({ user: user() });
      t.times.email = [{ at: new Date(t.clock.now().getTime() - 20_000), sameAddress: false }];
      const error = await t.service.requestCode(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('OTP_RESEND_TOO_SOON');
      expect((error as AppException).options.retryAfterSeconds).toBe(40);
      expect(t.stored).toHaveLength(0);
      expect(t.send).not.toHaveBeenCalled();
    });

    it('refuses when the account is locked', async () => {
      const t = build({
        user: user({ lockedUntil: new Date(nowMs() + 600_000) }),
      });
      await expect(t.service.requestCode(request())).rejects.toMatchObject({
        code: AuthCode.AUTH_LOCKED,
      });
    });

    it('gives each address its own three, and supersedes only codes from the same address', async () => {
      const t = build({ user: user() });
      const old = (seconds: number) => new Date(t.clock.now().getTime() - seconds * 1000);
      // Three from another address do not stop this one.
      t.times.email = [120, 300, 600].map((s) => ({ at: old(s), sameAddress: false }));
      await RequestContext.run({ requestId: 'r1', language: 'en', ipAddress: '203.0.113.9' }, () =>
        t.service.requestCode(request()),
      );
      expect(t.stored).toHaveLength(1);
      expect(t.repository.supersedeLive).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '203.0.113.9',
        expect.any(Date),
      );
      // Three from this address do.
      t.times.email = [120, 300, 600].map((s) => ({ at: old(s), sameAddress: true }));
      await expect(t.service.requestCode(request())).rejects.toMatchObject({
        code: 'OTP_REQUEST_LIMIT',
      });
    });

    it('refuses an unregistered email under a challenge lock, the same way', async () => {
      const t = build();
      t.times.lock = new Date(t.clock.now().getTime() + 600_000);
      await expect(t.service.requestCode(request())).rejects.toMatchObject({
        code: AuthCode.AUTH_LOCKED,
      });
    });

    it('uses the later of the account lock and the challenge lock', async () => {
      const t = build({ user: user({ lockedUntil: new Date(nowMs() + 60_000) }) });
      t.times.lock = new Date(t.clock.now().getTime() + 900_000);
      const error = (await t.service
        .requestCode(request())
        .catch((e: unknown) => e)) as AppException;
      expect(error.options.retryAfterSeconds).toBe(900);
    });

    it('asks the limiter about the IP first, and stops when it refuses', async () => {
      const t = build({ user: user() });
      t.check.mockRejectedValue(new AppException(429, 'RATE_LIMITED'));
      await expect(
        RequestContext.run({ requestId: 'r1', language: 'en', ipAddress: '203.0.113.9' }, () =>
          t.service.requestCode(request()),
        ),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(t.check).toHaveBeenCalledWith('203.0.113.9');
      expect(t.repository.tryLockEmail).not.toHaveBeenCalled();
      expect(t.stored).toHaveLength(0);
    });

    it('answers at once, as too soon, when another request for the email is running', async () => {
      const t = build({ user: user(), lockBusy: true });
      const error = (await t.service
        .requestCode(request())
        .catch((e: unknown) => e)) as AppException;
      expect(error.status).toBe(429);
      expect(error.code).toBe('OTP_RESEND_TOO_SOON');
      expect(error.options.retryAfterSeconds).toBe(60);
      expect(t.repository.findUserByEmail).not.toHaveBeenCalled();
      expect(t.stored).toHaveLength(0);
    });
  });

  describe('the caller address', () => {
    it('drops an IPv6 zone, which inet refuses', async () => {
      expect(await ipSeen('fe80::1%eth0')).toBe('fe80::1');
    });
    it('reads an IPv4-mapped caller as IPv4', async () => {
      expect(await ipSeen('::ffff:203.0.113.9')).toBe('203.0.113.9');
    });
    it('stores nothing for text that is not an address', async () => {
      expect(await ipSeen('not-an-ip')).toBeNull();
      expect(await ipSeen(undefined)).toBeNull();
    });
  });

  describe('sending', () => {
    it('answers normally when the mail fails, and logs neither the address nor the code', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const t = build({ user: user() });
      t.send.mockRejectedValue(new Error(`smtp refused ${EMAIL}`));
      await expect(t.service.requestCode(request())).resolves.toEqual({});
      await expect(t.service.flush()).resolves.toBeUndefined();
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('Login code email was not sent');
      expect(logged).not.toContain(EMAIL);
    });

    it('gives up on a send that never ends', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        const t = build({ user: user() });
        t.send.mockReturnValue(new Promise<undefined>(() => undefined));
        await t.service.requestCode(request());
        const flushed = t.service.flush();
        await vi.advanceTimersByTimeAsync(3000);
        await expect(flushed).resolves.toBeUndefined();
        expect(t.send).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('finishes pending mail on shutdown', async () => {
      const t = build({ user: user() });
      await t.service.requestCode(request());
      await expect(t.service.onModuleDestroy()).resolves.toBeUndefined();
      expect(t.send).toHaveBeenCalledOnce();
    });
  });
});

function nowMs(): number {
  return new FixedClock().now().getTime();
}
