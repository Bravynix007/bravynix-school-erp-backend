import { RequestContext } from '../../common/request-context/request-context.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService } from '../database/index.js';
import { AccountStatus } from './auth-codes.js';
import type { PublicCallLimiter } from './public-call-limiter.js';
import { SessionService } from './session.service.js';
import type { LockedRefreshToken, SessionRepository, SessionRow } from './session.repository.js';
import { TokenService } from './token.service.js';

/** Rules of AUTH-05, AUTH-07 and AUTH-08 with the database replaced; the SQL is covered by the integration tests. */
const SECRET = 'a'.repeat(32);
const tokens = new TokenService(undefined, 'k1', SECRET);
const PRESENTED = 'rt_presented';

const session = (patch: Partial<SessionRow> = {}): SessionRow => ({
  id: 'session-1',
  userId: 'user-1',
  clientType: 1,
  activeRoleCode: 2,
  activeSocietyId: 'soc-1',
  lastUsedAt: new Date('2026-10-26T00:00:00Z'),
  idleExpiresAt: new Date('2026-12-01T00:00:00Z'),
  absoluteExpiresAt: null,
  endedAt: null,
  endReason: null,
  accountStatus: AccountStatus.Active as number,
  ...patch,
});

function build(
  options: {
    found?: Partial<Omit<LockedRefreshToken, 'session'>> & { session?: Partial<SessionRow> };
    none?: boolean;
    granted?: boolean;
  } = {},
) {
  const clock = new FixedClock();
  const found: LockedRefreshToken | undefined = options.none
    ? undefined
    : {
        tokenId: 'token-1',
        expiresAt: new Date(clock.now().getTime() + 1000 * 3600),
        usedAt: null,
        ...options.found,
        session: session(options.found?.session),
      };
  const repository = {
    lockRefreshToken: vi.fn<SessionRepository['lockRefreshToken']>(async () => found),
    markTokenUsed: vi.fn<SessionRepository['markTokenUsed']>(async () => undefined),
    insertRefreshToken: vi.fn<SessionRepository['insertRefreshToken']>(async () => undefined),
    touchSession: vi.fn<SessionRepository['touchSession']>(async () => undefined),
    endSession: vi.fn<SessionRepository['endSession']>(async () => true),
    endUserSessions: vi.fn<SessionRepository['endUserSessions']>(async () => 2),
    hasGrant: vi.fn<SessionRepository['hasGrant']>(async () => options.granted ?? true),
  };
  const record = vi.fn<AuditService['record']>(async () => 'audit-id');
  const check = vi.fn<PublicCallLimiter['check']>(async () => undefined);
  const service = new SessionService(
    {
      transaction: (_tenant: unknown, work: (tx: unknown) => unknown) => work({}),
    } as DatabaseService,
    repository as unknown as SessionRepository,
    { record } as unknown as AuditService,
    clock,
    tokens,
    { check } as unknown as PublicCallLimiter,
  );
  return { service, repository, record, check, clock };
}

const fail = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { status: number; code: string; options: { details?: Record<string, unknown> } };

const principal = {
  personId: 'user-1',
  sessionId: 'session-1',
  roleCode: 2 as const,
  societyId: 'soc-1',
  clientType: 'mobile' as const,
  viaSupportAccess: false,
};

describe('SessionService.refresh', () => {
  it('uses the token up, stores a new one and moves the idle deadline 30 days on', async () => {
    const t = build();
    const result = await RequestContext.run(
      { requestId: 'r1', language: 'en', ipAddress: '203.0.113.9' },
      () => t.service.refresh(PRESENTED),
    );
    const now = t.clock.now();
    expect(t.check).toHaveBeenCalledWith('203.0.113.9');
    expect(t.repository.lockRefreshToken).toHaveBeenCalledWith(
      expect.anything(),
      tokens.refreshTokenHmac(PRESENTED),
    );
    expect(t.repository.markTokenUsed).toHaveBeenCalledWith(expect.anything(), 'token-1', now);
    const stored = t.repository.insertRefreshToken.mock.calls[0]![1];
    expect(stored.hmac.equals(tokens.refreshTokenHmac(result.refreshToken))).toBe(true);
    expect(stored.expiresAt.getTime()).toBe(now.getTime() + 30 * 86_400_000);
    expect(t.repository.touchSession).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      now,
      stored.expiresAt,
    );
    const check = await tokens.checkAccessToken(result.accessToken, now);
    expect(check).toMatchObject({
      status: 'valid',
      claims: { personId: 'user-1', sessionId: 'session-1', roleCode: 2, societyId: 'soc-1' },
    });
  });

  it('refuses an unknown token', async () => {
    const t = build({ none: true });
    expect(await fail(t.service.refresh(PRESENTED))).toMatchObject({
      status: 401,
      code: 'REFRESH_TOKEN_INVALID',
    });
    expect(t.repository.markTokenUsed).not.toHaveBeenCalled();
  });

  it('ends the session and audits when a used token comes back', async () => {
    const t = build({ found: { usedAt: new Date() } });
    expect(await fail(t.service.refresh(PRESENTED))).toMatchObject({
      status: 401,
      code: 'REFRESH_TOKEN_REUSED',
    });
    expect(t.repository.endSession).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      5,
      t.clock.now(),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.token_reuse', entityId: 'user-1', outcome: 2 }),
    );
    expect(t.repository.insertRefreshToken).not.toHaveBeenCalled();
  });

  it('names the reason when the session had already ended', async () => {
    const ended = build({ found: { session: { endedAt: new Date(), endReason: 1 } } });
    expect(await fail(ended.service.refresh(PRESENTED))).toMatchObject({
      status: 401,
      code: 'SESSION_ENDED',
      options: { details: { reason: 'logout' } },
    });
    // Even a used token on an ended session reports the end, not a reuse.
    const used = build({
      found: { usedAt: new Date(), session: { endedAt: new Date(), endReason: 2 } },
    });
    expect((await fail(used.service.refresh(PRESENTED))).code).toBe('SESSION_ENDED');
    expect(used.repository.endSession).not.toHaveBeenCalled();
  });

  it('ends a session whose token or idle deadline has passed', async () => {
    const lapsed = build({ found: { expiresAt: new Date('2026-01-01T00:00:00Z') } });
    expect((await fail(lapsed.service.refresh(PRESENTED))).code).toBe('REFRESH_TOKEN_INVALID');
    expect(lapsed.repository.endSession).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      6,
      lapsed.clock.now(),
    );

    const idle = build({ found: { session: { idleExpiresAt: new Date('2026-01-01T00:00:00Z') } } });
    expect((await fail(idle.service.refresh(PRESENTED))).code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('does not renew a console session from a body token', async () => {
    const t = build({ found: { session: { clientType: 2 } } });
    expect((await fail(t.service.refresh(PRESENTED))).code).toBe('REFRESH_TOKEN_INVALID');
    expect(t.repository.markTokenUsed).not.toHaveBeenCalled();
  });

  it('ends every session of a blocked or inactive person', async () => {
    for (const accountStatus of [AccountStatus.Blocked, AccountStatus.Inactive]) {
      const t = build({ found: { session: { accountStatus } } });
      expect(await fail(t.service.refresh(PRESENTED))).toMatchObject({
        code: 'SESSION_ENDED',
        options: { details: { reason: 'blocked' } },
      });
      expect(t.repository.endUserSessions).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        3,
        t.clock.now(),
      );
    }
  });

  it('ends the session when the grant behind the active role is gone', async () => {
    const t = build({ granted: false });
    expect(await fail(t.service.refresh(PRESENTED))).toMatchObject({
      code: 'SESSION_ENDED',
      options: { details: { reason: 'admin_revoked' } },
    });
    expect(t.repository.hasGrant).toHaveBeenCalledWith(expect.anything(), 'user-1', 2, 'soc-1');
  });

  it('does not look for a grant when there is no context or the role is a staff or parent role', async () => {
    for (const activeRoleCode of [null, 4, 5]) {
      const t = build({ found: { session: { activeRoleCode, activeSocietyId: null } } });
      await t.service.refresh(PRESENTED);
      expect(t.repository.hasGrant).not.toHaveBeenCalled();
    }
  });
});

describe('SessionService.logout and logoutAll', () => {
  it('ends this session and audits it', async () => {
    const t = build();
    await t.service.logout(principal);
    expect(t.repository.endSession).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      1,
      t.clock.now(),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'auth.logout',
        entityId: 'user-1',
        after: { sessionsEnded: 1 },
      }),
    );
  });

  it('ends every session of the person and audits how many', async () => {
    const t = build();
    await t.service.logoutAll(principal);
    expect(t.repository.endUserSessions).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      2,
      t.clock.now(),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.logout_all', after: { sessionsEnded: 2 } }),
    );
  });
});
