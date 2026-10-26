import { RequestContext } from '../../common/request-context/request-context.js';
import { FixedClock } from '../../common/time/clock.js';
import type { EmailSender } from '../email/email-sender.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService } from '../database/index.js';
import { AccountStatus, ClientType } from './auth-codes.js';
import { BackgroundMailer } from './background-mailer.js';
import type { IdentityRepository, LiveChallenge, LoginUser } from './identity.repository.js';
import { LoginService, type VerifyRequest } from './login.service.js';
import { OtpHasher } from './otp-hasher.js';
import type { PublicCallLimiter } from './public-call-limiter.js';
import type { Grant, SessionRepository } from './session.repository.js';
import { TokenService } from './token.service.js';

/** Rules of AUTH-02 with the database replaced; the SQL itself is covered by the integration tests. */
const EMAIL = 'asha@two-worlds.test';
const SECRET = 'a'.repeat(32);
const hasher = new OtpHasher(SECRET);
const CODE = '482913';

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
  options: {
    user?: LoginUser;
    live?: LiveChallenge[];
    lockouts?: number;
    grants?: Grant[];
    lock?: Date | null;
    busy?: boolean;
  } = {},
) {
  const identity = {
    tryLockEmail: vi.fn<IdentityRepository['tryLockEmail']>(async () => !options.busy),
    findUserByEmail: vi.fn<IdentityRepository['findUserByEmail']>(async () => options.user),
    activeChallengeLock: vi.fn<IdentityRepository['activeChallengeLock']>(
      async () => options.lock ?? null,
    ),
    liveChallenges: vi.fn<IdentityRepository['liveChallenges']>(async () => options.live ?? []),
    setAttemptCount: vi.fn<IdentityRepository['setAttemptCount']>(async () => undefined),
    lockChallenges: vi.fn<IdentityRepository['lockChallenges']>(async () => undefined),
    lockoutsSince: vi.fn<IdentityRepository['lockoutsSince']>(async () => options.lockouts ?? 0),
    recordLockout: vi.fn<IdentityRepository['recordLockout']>(async () => undefined),
    consumeChallenge: vi.fn<IdentityRepository['consumeChallenge']>(async () => undefined),
    setUserFailures: vi.fn<IdentityRepository['setUserFailures']>(async () => undefined),
    recordLogin: vi.fn<IdentityRepository['recordLogin']>(async () => undefined),
    clearFailures: vi.fn<IdentityRepository['clearFailures']>(async () => undefined),
  };
  const sessions = {
    activeGrants: vi.fn<SessionRepository['activeGrants']>(async () => options.grants ?? []),
    createSession: vi.fn<SessionRepository['createSession']>(async () => undefined),
    insertRefreshToken: vi.fn<SessionRepository['insertRefreshToken']>(async () => undefined),
  };
  const record = vi.fn<AuditService['record']>(async () => 'audit-id');
  const check = vi.fn<PublicCallLimiter['check']>(async () => undefined);
  const send = vi.fn<EmailSender['send']>(async () => undefined);
  const mailer = new BackgroundMailer({ send } as unknown as EmailSender);
  const clock = new FixedClock();
  const tokens = new TokenService(undefined, 'k1', SECRET);
  const service = new LoginService(
    {
      transaction: (_tenant: unknown, work: (tx: unknown) => unknown) => work({}),
    } as DatabaseService,
    identity as unknown as IdentityRepository,
    sessions as unknown as SessionRepository,
    { record } as unknown as AuditService,
    clock,
    hasher,
    tokens,
    { check } as unknown as PublicCallLimiter,
    mailer,
  );
  return { service, identity, sessions, record, check, clock, tokens, send, mailer };
}

const live = (attemptCount = 0, code: string | null = CODE, id = 'c1'): LiveChallenge => ({
  id,
  userId: code === null ? null : user().id,
  codeHmac: code === null ? null : hasher.code(EMAIL, code),
  attemptCount,
});
const request = (patch: Partial<VerifyRequest> = {}): VerifyRequest => ({
  email: EMAIL,
  code: CODE,
  clientType: ClientType.Mobile,
  device: { platform: 1, appVersion: '1.4.0', label: 'Pixel' },
  ...patch,
});
const owner: Grant = { roleCode: 2, societyId: 'soc-1', institutionId: null };
const fail = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as {
    status: number;
    code: string;
    options: { retryAfterSeconds?: number; details?: Record<string, unknown> };
  };

const lockOut = (options: Parameters<typeof build>[0]) => {
  const t = build(options);
  return { t, error: fail(t.service.verify(request({ code: '000000' }))) };
};

describe('LoginService.verify', () => {
  it('starts a session in the only context, signs a token for it and audits the login', async () => {
    const t = build({ user: user(), live: [live()], grants: [owner] });
    const result = await RequestContext.run(
      { requestId: 'r1', language: 'en', ipAddress: '203.0.113.9', userAgent: 'erp/1' },
      () => t.service.verify(request()),
    );
    expect(result).toMatchObject({
      userType: 2,
      userTypeName: 'society_owner',
      session: { activeContext: { roleCode: 2, societyId: 'soc-1' } },
      person: { email: EMAIL, accountStatus: 1 },
      contexts: [{ roleCode: 2, societyId: 'soc-1' }],
    });
    expect(t.identity.consumeChallenge).toHaveBeenCalledOnce();
    expect(t.identity.recordLogin).toHaveBeenCalledOnce();
    expect(t.sessions.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clientType: 1,
        activeRoleCode: 2,
        activeSocietyId: 'soc-1',
        ip: '203.0.113.9',
        userAgent: 'erp/1',
        deviceLabel: 'Pixel',
      }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.login', societyId: null, institutionId: null }),
    );
    expect(t.check).toHaveBeenCalledWith('203.0.113.9');
    const check = await t.tokens.checkAccessToken(result.accessToken, t.clock.now());
    expect(check).toMatchObject({ status: 'valid', claims: { roleCode: 2, societyId: 'soc-1' } });
  });

  it('stores only the hash of the refresh token it returns', async () => {
    const t = build({ user: user(), live: [live()], grants: [owner] });
    const result = await t.service.verify(request());
    const stored = t.sessions.insertRefreshToken.mock.calls[0]![1];
    expect(stored.hmac.equals(t.tokens.refreshTokenHmac(result.refreshToken))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(result.refreshToken);
  });

  it('leaves the context open when there are several, or none, and drops the Super Admin role', async () => {
    const two = build({
      user: user(),
      live: [live()],
      grants: [owner, { roleCode: 3, societyId: 'soc-1', institutionId: 'ins-1' }],
    });
    const several = await two.service.verify(request());
    expect(several.session.activeContext).toBeNull();
    expect(several.userType).toBeNull();
    expect(several.contexts).toHaveLength(2);

    const sa = build({
      user: user(),
      live: [live()],
      grants: [{ roleCode: 1, societyId: null, institutionId: null }],
    });
    const onlyConsole = await sa.service.verify(request());
    expect(onlyConsole.contexts).toEqual([]);
    expect(onlyConsole.session.activeContext).toBeNull();
  });

  it('reports a Pending account as Active, since the login makes it so', async () => {
    const t = build({ user: user({ accountStatus: AccountStatus.Pending }), live: [live()] });
    expect((await t.service.verify(request())).person.accountStatus).toBe(1);
  });

  it('answers a wrong code with the tries left, counted on every live code', async () => {
    const t = build({ user: user(), live: [live(1, CODE, 'c1'), live(1, '111111', 'c2')] });
    const error = await fail(t.service.verify(request({ code: '000000' })));
    expect(error).toMatchObject({
      status: 401,
      code: 'OTP_INVALID',
      options: { details: { attemptsLeft: 3 } },
    });
    expect(t.identity.setAttemptCount).toHaveBeenCalledWith(expect.anything(), ['c1', 'c2'], 2);
    expect(t.identity.setUserFailures).toHaveBeenCalledWith(expect.anything(), user().id, 2, null);
    expect(t.sessions.createSession).not.toHaveBeenCalled();
  });

  it('locks the email on the fifth wrong code, for a registered and an unknown email alike', async () => {
    const registered = build({ user: user(), live: [live(4)] });
    const unknown = build({ live: [live(4, null)] });
    for (const t of [registered, unknown]) {
      const error = await fail(t.service.verify(request({ code: '000000' })));
      expect(error).toMatchObject({
        status: 401,
        code: 'OTP_ATTEMPTS_EXCEEDED',
        options: { retryAfterSeconds: 1800 },
      });
      expect(t.identity.lockChallenges).toHaveBeenCalledOnce();
      expect(t.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'auth.lockout', outcome: 2 }),
      );
    }
    expect(registered.identity.setUserFailures).toHaveBeenCalledWith(
      expect.anything(),
      user().id,
      0,
      expect.any(Date),
    );
    // The same statement runs for an unknown email, with an id that matches no row.
    expect(unknown.identity.setUserFailures).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000000',
      0,
      expect.any(Date),
    );
    expect(unknown.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ entityId: expect.anything() }),
    );
    expect(registered.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityType: 'user', entityId: user().id }),
    );
  });

  describe('the third lockout in 24 hours', () => {
    it('locks for 30 minutes the first and second time, counting the earlier ones', async () => {
      for (const lockouts of [0, 1]) {
        const { t, error } = lockOut({ user: user(), live: [live(4)], lockouts });
        expect(await error).toMatchObject({ options: { retryAfterSeconds: 1800 } });
        expect(t.identity.recordLockout).toHaveBeenCalledWith(
          expect.anything(),
          hasher.email(EMAIL),
          new Date(t.clock.now().getTime() + 1800 * 1000),
          t.clock.now(),
        );
      }
    });

    it('locks for 24 hours the third time, on the challenges and the account', async () => {
      const { t, error } = lockOut({ user: user(), live: [live(4)], lockouts: 2 });
      expect(await error).toMatchObject({
        status: 401,
        code: 'OTP_ATTEMPTS_EXCEEDED',
        options: { retryAfterSeconds: 86400 },
      });
      const until = new Date(t.clock.now().getTime() + 86400 * 1000);
      expect(t.identity.lockChallenges).toHaveBeenCalledWith(
        expect.anything(),
        hasher.email(EMAIL),
        until,
        new Date(t.clock.now().getTime() - 86400 * 1000),
      );
      expect(t.identity.setUserFailures).toHaveBeenCalledWith(
        expect.anything(),
        user().id,
        0,
        until,
      );
      expect(t.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'auth.lockout',
          after: { lockoutsIn24Hours: 3, lockSeconds: 86400 },
        }),
      );
    });

    it('counts lockouts of an unknown email in the same way', async () => {
      const { error } = lockOut({ live: [live(4, null)], lockouts: 2 });
      expect(await error).toMatchObject({ options: { retryAfterSeconds: 86400 } });
    });

    it('mails a registered person, with the length of the lock, after the answer is decided', async () => {
      const { t, error } = lockOut({ user: user(), live: [live(4)], lockouts: 2 });
      await error;
      await t.mailer.flush();
      expect(t.send).toHaveBeenCalledOnce();
      const mail = t.send.mock.calls[0]![0];
      expect(mail).toMatchObject({ to: EMAIL, template: 'login-lockout' });
      expect(mail.text).toContain('24 hours');
    });

    it('sends no mail for an unknown email, an inactive account or a wrong code that is not a lockout', async () => {
      const unknown = lockOut({ live: [live(4, null)] });
      const inactive = lockOut({
        user: user({ accountStatus: AccountStatus.Inactive }),
        live: [live(4)],
      });
      const notYet = lockOut({ user: user(), live: [live(2)] });
      await Promise.all([unknown.error, inactive.error, notYet.error]);
      for (const { t } of [unknown, inactive, notYet]) {
        await t.mailer.flush();
        expect(t.send).not.toHaveBeenCalled();
      }
    });
  });

  it('never matches a code stored for no account', async () => {
    const t = build({ live: [live(0, null)] });
    const error = await fail(t.service.verify(request()));
    expect(error.code).toBe('OTP_INVALID');
  });

  it('accepts any of several live codes', async () => {
    const t = build({
      user: user(),
      live: [live(0, '111111', 'c1'), live(0, CODE, 'c2')],
      grants: [owner],
    });
    await t.service.verify(request());
    expect(t.identity.consumeChallenge.mock.calls[0]![2]).toBe('c2');
  });

  it('says the code is expired when nothing can be tried', async () => {
    const t = build({ user: user(), live: [] });
    expect(await fail(t.service.verify(request()))).toMatchObject({
      status: 401,
      code: 'OTP_EXPIRED',
    });
  });

  it('refuses a locked email before looking at the code, from the account or from a challenge', async () => {
    const until = new Date(new FixedClock().now().getTime() + 600_000);
    const account = build({ user: user({ lockedUntil: until }), live: [live()] });
    expect(await fail(account.service.verify(request()))).toMatchObject({
      status: 423,
      code: 'AUTH_LOCKED',
      options: { retryAfterSeconds: 600 },
    });
    const challenge = build({ live: [live(0, null)], lock: until });
    expect(await fail(challenge.service.verify(request()))).toMatchObject({ status: 423 });
    expect(account.identity.liveChallenges).not.toHaveBeenCalled();
  });

  it('answers at once, as busy, when another attempt for the email is running', async () => {
    const t = build({ user: user(), live: [live()], busy: true });
    expect(await fail(t.service.verify(request()))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      options: { retryAfterSeconds: 1 },
    });
    expect(t.identity.findUserByEmail).not.toHaveBeenCalled();
  });

  it('refuses a Blocked account after a correct code and uses the code up', async () => {
    const t = build({ user: user({ accountStatus: AccountStatus.Blocked }), live: [live()] });
    expect(await fail(t.service.verify(request()))).toMatchObject({
      status: 403,
      code: 'ACCOUNT_BLOCKED',
    });
    expect(t.identity.consumeChallenge).toHaveBeenCalledOnce();
    expect(t.sessions.createSession).not.toHaveBeenCalled();
  });

  it('refuses the console to anyone but a Super Admin, and keeps the code for a Super Admin', async () => {
    const consoleRequest = request({ clientType: ClientType.Console, device: undefined });
    const teacher = build({ user: user(), live: [live()], grants: [owner] });
    expect(await fail(teacher.service.verify(consoleRequest))).toMatchObject({
      status: 403,
      code: 'CONSOLE_NOT_ALLOWED',
    });
    expect(teacher.identity.consumeChallenge).toHaveBeenCalledOnce();

    const admin = build({
      user: user(),
      live: [live()],
      grants: [{ roleCode: 1, societyId: null, institutionId: null }],
    });
    expect(await fail(admin.service.verify(consoleRequest))).toMatchObject({ status: 503 });
    expect(admin.identity.consumeChallenge).not.toHaveBeenCalled();
    expect(admin.sessions.createSession).not.toHaveBeenCalled();
  });

  it('stops at the per-IP limit before touching the database', async () => {
    const t = build({ user: user(), live: [live()] });
    t.check.mockRejectedValue(new Error('limited'));
    await expect(t.service.verify(request())).rejects.toThrow('limited');
    expect(t.identity.tryLockEmail).not.toHaveBeenCalled();
  });

  it('normalises the email before hashing and looking it up', async () => {
    const t = build({ user: user(), live: [live()], grants: [owner] });
    await t.service.verify(request({ email: `  ${EMAIL.toUpperCase()} ` }));
    expect(t.identity.findUserByEmail).toHaveBeenCalledWith(expect.anything(), EMAIL);
  });
});
