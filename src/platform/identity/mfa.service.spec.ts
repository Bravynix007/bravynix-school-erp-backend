import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService } from '../database/index.js';
import { AccountStatus } from './auth-codes.js';
import type { IdentityRepository, LoginUser } from './identity.repository.js';
import type { LockedMfaChallenge, MfaRepository, TotpFactor } from './mfa.repository.js';
import { MFA_LIMITS, MfaService } from './mfa.service.js';
import type { PublicCallLimiter } from './public-call-limiter.js';
import { SecretBox } from './secret-box.js';
import type { SessionRepository } from './session.repository.js';
import { TokenService } from './token.service.js';
import { stepAt, totpAt } from './totp.js';

/** Rules of AUTH-03 and AUTH-04 with the database replaced; the SQL and the flow are covered by the integration tests. */
const SECRET = 'a'.repeat(32);
const USER_ID = '0192b0e0-0000-7000-8000-000000000001';
const tokens = new TokenService(undefined, 'k1', SECRET);
const box = new SecretBox(undefined);
const authenticator = Buffer.from('12345678901234567890');

const user = (patch: Partial<LoginUser> = {}): LoginUser => ({
  id: USER_ID,
  email: 'root@two-worlds.test',
  firstName: 'Root',
  lastName: 'Admin',
  accountStatus: AccountStatus.Active as number,
  preferredLanguage: 'en',
  lockedUntil: null,
  ...patch,
});

function build(
  options: {
    challenge?: Partial<LockedMfaChallenge> | null;
    user?: LoginUser | null;
    superAdmin?: boolean;
    factor?: Partial<TotpFactor> | null;
    stepFree?: boolean;
    saved?: boolean;
    failedTries?: number;
  } = {},
) {
  const clock = new FixedClock();
  const now = clock.now();
  const challenge: LockedMfaChallenge | undefined =
    options.challenge === null
      ? undefined
      : {
          id: 'challenge-1',
          userId: USER_ID,
          expiresAt: new Date(now.getTime() + 60_000),
          usedAt: null,
          failedTries: 0,
          ...options.challenge,
        };
  const factor: TotpFactor | undefined =
    options.factor === null
      ? undefined
      : {
          secretCiphertext: box.seal(authenticator, USER_ID),
          confirmedAt: new Date('2026-05-01T00:00:00Z'),
          lastUsedStep: null,
          ...options.factor,
        };
  const factors = {
    findFactor: vi.fn<MfaRepository['findFactor']>(async () => factor),
    savePendingFactor: vi.fn<MfaRepository['savePendingFactor']>(async () => options.saved ?? true),
    useStep: vi.fn<MfaRepository['useStep']>(async () => options.stepFree ?? true),
    insertChallenge: vi.fn<MfaRepository['insertChallenge']>(async () => undefined),
    spendOpenChallenges: vi.fn<MfaRepository['spendOpenChallenges']>(async () => undefined),
    lockChallenge: vi.fn<MfaRepository['lockChallenge']>(async () => challenge),
    addFailedTry: vi.fn<MfaRepository['addFailedTry']>(async () => options.failedTries ?? 1),
    spendChallenge: vi.fn<MfaRepository['spendChallenge']>(async () => undefined),
  };
  const identity = {
    findUserById: vi.fn<IdentityRepository['findUserById']>(async () =>
      options.user === null ? undefined : (options.user ?? user()),
    ),
    hasActiveSuperAdminGrant: vi.fn<IdentityRepository['hasActiveSuperAdminGrant']>(
      async () => options.superAdmin ?? true,
    ),
    recordLogin: vi.fn<IdentityRepository['recordLogin']>(async () => undefined),
  };
  const sessions = {
    createSession: vi.fn<SessionRepository['createSession']>(async () => undefined),
    insertRefreshToken: vi.fn<SessionRepository['insertRefreshToken']>(async () => undefined),
  };
  const record = vi.fn<AuditService['record']>(async () => 'audit-id');
  const check = vi.fn<PublicCallLimiter['check']>(async () => undefined);
  const service = new MfaService(
    {
      transaction: (_tenant: unknown, work: (tx: unknown) => unknown) => work({}),
    } as DatabaseService,
    identity as unknown as IdentityRepository,
    sessions as unknown as SessionRepository,
    factors as unknown as MfaRepository,
    { record } as unknown as AuditService,
    clock,
    tokens,
    box,
    { check } as unknown as PublicCallLimiter,
  );
  return { service, factors, identity, sessions, record, check, clock, now };
}

const fail = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { status: number; code: string; options: { details?: Record<string, unknown> } };

const goodCode = (now: Date, offset = 0) => totpAt(authenticator, stepAt(now) + offset);
const actions = (t: ReturnType<typeof build>) =>
  t.record.mock.calls.map(([, entry]) => entry.action);

describe('MfaService.begin', () => {
  it('replaces earlier tokens and stores only the hash of the new one, for 5 minutes', async () => {
    const t = build();
    const started = await t.service.begin({} as never, USER_ID, t.now);
    expect(started.mfaToken).toMatch(/^mfa_/);
    expect(started.mfaEnrolled).toBe(true);
    expect(t.factors.spendOpenChallenges).toHaveBeenCalledOnce();
    const stored = t.factors.insertChallenge.mock.calls[0]![1];
    expect(stored.hmac.equals(tokens.mfaTokenHmac(started.mfaToken))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(started.mfaToken);
    expect(stored.expiresAt.getTime() - t.now.getTime()).toBe(MFA_LIMITS.tokenSeconds * 1000);
  });

  it('says a factor that was started but never confirmed is not enrolled', async () => {
    const pending = build({ factor: { confirmedAt: null } });
    expect((await pending.service.begin({} as never, USER_ID, pending.now)).mfaEnrolled).toBe(
      false,
    );
    const none = build({ factor: null });
    expect((await none.service.begin({} as never, USER_ID, none.now)).mfaEnrolled).toBe(false);
  });
});

describe('MfaService.verify', () => {
  it('signs in with a right code: spends the token, records the step and starts a 12-hour session', async () => {
    const t = build();
    const login = await t.service.verify('mfa_x', goodCode(t.now));
    expect(t.check).toHaveBeenCalledOnce();
    expect(t.factors.useStep).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      stepAt(t.now),
      t.now,
    );
    expect(t.factors.spendChallenge).toHaveBeenCalledWith(expect.anything(), 'challenge-1', t.now);
    const end = new Date(t.now.getTime() + 12 * 3600 * 1000);
    expect(t.sessions.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clientType: 2,
        activeRoleCode: 1,
        activeSocietyId: null,
        idleExpiresAt: end,
        absoluteExpiresAt: end,
      }),
    );
    expect(t.sessions.insertRefreshToken.mock.calls[0]![1].expiresAt).toEqual(end);
    expect(login.result).toMatchObject({
      userType: 1,
      userTypeName: 'super_admin',
      refreshToken: null,
      contexts: [{ roleCode: 1, societyId: null }],
      session: { activeContext: { roleCode: 1, societyId: null } },
    });
    expect(login.refreshCookie).toEqual({
      value: expect.stringMatching(/^rt_/),
      maxAgeSeconds: 12 * 3600,
    });
    const stored = t.sessions.insertRefreshToken.mock.calls[0]![1];
    expect(stored.hmac.equals(tokens.refreshTokenHmac(login.refreshCookie.value))).toBe(true);
    expect(actions(t)).toEqual(['auth.login']);
    const claims = await tokens.checkAccessToken(login.result.accessToken, t.now);
    expect(claims).toMatchObject({
      claims: { roleCode: 1, societyId: null, clientType: 'console' },
    });
  });

  it('audits the first confirmation of the authenticator as well', async () => {
    const t = build({ factor: { confirmedAt: null } });
    await t.service.verify('mfa_x', goodCode(t.now));
    expect(actions(t)).toEqual(['auth.mfa_enrolled', 'auth.login']);
  });

  it('accepts the step before and after now, for a phone clock a little off', async () => {
    for (const offset of [-1, 1]) {
      const t = build();
      await t.service.verify('mfa_x', goodCode(t.now, offset));
      expect(t.factors.useStep).toHaveBeenCalledOnce();
    }
  });

  it('counts a wrong code and says how many tries are left', async () => {
    const t = build({ failedTries: 2 });
    const error = await fail(t.service.verify('mfa_x', '000000'));
    expect(error).toMatchObject({
      status: 401,
      code: 'MFA_INVALID',
      options: { details: { attemptsLeft: 3 } },
    });
    expect(t.sessions.createSession).not.toHaveBeenCalled();
    expect(t.factors.spendChallenge).not.toHaveBeenCalled();
    expect(actions(t)).toEqual([]);
  });

  it('kills the token at the fifth wrong code and audits it', async () => {
    const t = build({ failedTries: MFA_LIMITS.triesPerToken });
    expect(await fail(t.service.verify('mfa_x', '000000'))).toMatchObject({
      code: 'MFA_INVALID',
      options: { details: { attemptsLeft: 0 } },
    });
    expect(actions(t)).toEqual(['auth.mfa_locked']);
    expect(t.record.mock.calls[0]![1]).toMatchObject({ outcome: 2 });
  });

  it('refuses a code that was already used, or one a parallel sign-in used first', async () => {
    const replay = build({ factor: { lastUsedStep: stepAt(new FixedClock().now()) } });
    expect(await fail(replay.service.verify('mfa_x', goodCode(replay.now)))).toMatchObject({
      code: 'MFA_INVALID',
    });
    expect(replay.factors.useStep).not.toHaveBeenCalled();

    const raced = build({ stepFree: false });
    expect(await fail(raced.service.verify('mfa_x', goodCode(raced.now)))).toMatchObject({
      code: 'MFA_INVALID',
    });
    expect(raced.sessions.createSession).not.toHaveBeenCalled();
  });

  it('answers MFA_TOKEN_EXPIRED for an unknown, used, lapsed or worn-out token', async () => {
    const past = new Date('2026-01-01T00:00:00Z');
    const cases = [
      build({ challenge: null }),
      build({ challenge: { usedAt: past } }),
      build({ challenge: { expiresAt: past } }),
      build({ challenge: { failedTries: MFA_LIMITS.triesPerToken } }),
      build({ user: null }),
      build({ user: user({ accountStatus: AccountStatus.Inactive }) }),
    ];
    for (const t of cases) {
      expect(await fail(t.service.verify('mfa_x', goodCode(t.now)))).toMatchObject({
        status: 401,
        code: 'MFA_TOKEN_EXPIRED',
      });
      expect(t.factors.useStep).not.toHaveBeenCalled();
      expect(t.sessions.createSession).not.toHaveBeenCalled();
    }
  });

  it('spends the token and refuses a person who was blocked or lost the Super Admin grant meanwhile', async () => {
    const blocked = build({ user: user({ accountStatus: AccountStatus.Blocked }) });
    expect(await fail(blocked.service.verify('mfa_x', goodCode(blocked.now)))).toMatchObject({
      status: 403,
      code: 'ACCOUNT_BLOCKED',
    });
    expect(blocked.factors.spendChallenge).toHaveBeenCalledOnce();

    const revoked = build({ superAdmin: false });
    expect(await fail(revoked.service.verify('mfa_x', goodCode(revoked.now)))).toMatchObject({
      status: 403,
      code: 'CONSOLE_NOT_ALLOWED',
    });
    expect(revoked.factors.spendChallenge).toHaveBeenCalledOnce();
    expect(revoked.sessions.createSession).not.toHaveBeenCalled();
  });

  it('says to set up the authenticator first when there is none', async () => {
    const t = build({ factor: null });
    expect(await fail(t.service.verify('mfa_x', '123456'))).toMatchObject({
      status: 409,
      code: 'MFA_NOT_ENROLLED',
    });
  });

  it('stops at the per-IP limit first', async () => {
    const t = build();
    t.check.mockRejectedValueOnce(new Error('limited'));
    await expect(t.service.verify('mfa_x', '123456')).rejects.toThrow('limited');
    expect(t.factors.lockChallenge).not.toHaveBeenCalled();
  });
});

describe('MfaService.enrol', () => {
  it('stores the secret sealed for this person and returns the setup link once', async () => {
    const t = build({ factor: { confirmedAt: null } });
    const enrolment = await t.service.enrol('mfa_x');
    const sealed = t.factors.savePendingFactor.mock.calls[0]![2];
    const stored = box.open(sealed, USER_ID);
    expect(stored).toHaveLength(20);
    expect(enrolment.setupUri).toMatch(/^otpauth:\/\/totp\/.+secret=/);
    expect(enrolment.setupUri).toContain(enrolment.secret);
    expect(sealed.includes(stored)).toBe(false);
    expect(actions(t)).toEqual(['auth.mfa_enrol_started']);
    // Enrolling does not use up the token or count as a wrong try.
    expect(t.factors.spendChallenge).not.toHaveBeenCalled();
    expect(t.factors.addFailedTry).not.toHaveBeenCalled();
  });

  it('refuses when an authenticator is already confirmed', async () => {
    const t = build({ saved: false });
    expect(await fail(t.service.enrol('mfa_x'))).toMatchObject({
      status: 409,
      code: 'MFA_ALREADY_ENROLLED',
    });
    expect(t.record).not.toHaveBeenCalled();
  });

  it('applies the same token rules as verify', async () => {
    const t = build({ challenge: { usedAt: new Date('2026-01-01T00:00:00Z') } });
    expect(await fail(t.service.enrol('mfa_x'))).toMatchObject({ code: 'MFA_TOKEN_EXPIRED' });
    const other = build({ superAdmin: false });
    expect(await fail(other.service.enrol('mfa_x'))).toMatchObject({ code: 'CONSOLE_NOT_ALLOWED' });
    expect(other.factors.savePendingFactor).not.toHaveBeenCalled();
  });
});
