import { FixedClock } from '../../common/time/clock.js';
import type { DatabaseService } from '../database/index.js';
import { AccountStatus } from './auth-codes.js';
import { SessionTokenVerifier } from './session-token-verifier.js';
import type { SessionRepository, SessionRow } from './session.repository.js';
import { TokenService } from './token.service.js';

/** The per-request check with the database replaced; the SQL is covered by the integration tests. */
const tokens = new TokenService(undefined, 'k1', 'a'.repeat(32));
const clock = new FixedClock();

const row = (patch: Partial<SessionRow> = {}): SessionRow => ({
  id: 'session-1',
  userId: 'user-1',
  clientType: 1,
  activeRoleCode: 2,
  activeSocietyId: 'soc-1',
  lastUsedAt: clock.now(),
  idleExpiresAt: new Date(clock.now().getTime() + 30 * 86_400_000),
  absoluteExpiresAt: null,
  endedAt: null,
  endReason: null,
  accountStatus: AccountStatus.Active as number,
  ...patch,
});

async function build(options: { session?: SessionRow | null; granted?: boolean } = {}) {
  const found = options.session === undefined ? row() : (options.session ?? undefined);
  const repository = {
    findSession: vi.fn<SessionRepository['findSession']>(async () => found),
    endSession: vi.fn<SessionRepository['endSession']>(async () => true),
    endUserSessions: vi.fn<SessionRepository['endUserSessions']>(async () => 1),
    touchSession: vi.fn<SessionRepository['touchSession']>(async () => undefined),
    hasGrant: vi.fn<SessionRepository['hasGrant']>(async () => options.granted ?? true),
  };
  const verifier = new SessionTokenVerifier(
    { db: {} } as DatabaseService,
    repository as unknown as SessionRepository,
    tokens,
    clock,
  );
  const signed = await tokens.signAccessToken(
    {
      personId: 'user-1',
      sessionId: 'session-1',
      roleCode: 4,
      societyId: null,
      clientType: 'mobile',
    },
    clock.now(),
  );
  return { verifier, repository, token: signed.token };
}

const fail = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { status: number; code: string; options: { details?: Record<string, unknown> } };

describe('SessionTokenVerifier.verify', () => {
  it('takes the role and Society from the session, not from the token', async () => {
    const t = await build();
    // The token says role 4; the session says role 2.
    expect(await t.verifier.verify(t.token)).toEqual({
      personId: 'user-1',
      sessionId: 'session-1',
      roleCode: 2,
      societyId: 'soc-1',
      clientType: 'mobile',
      viaSupportAccess: false,
    });
  });

  it('gives a session with no context a null role', async () => {
    const t = await build({ session: row({ activeRoleCode: null, activeSocietyId: null }) });
    expect((await t.verifier.verify(t.token)).roleCode).toBeNull();
  });

  it('refuses a token that is invalid, and one that has expired', async () => {
    const t = await build();
    expect(await fail(t.verifier.verify('nonsense'))).toMatchObject({
      status: 401,
      code: 'TOKEN_INVALID',
    });
    clock.advance(16 * 60_000);
    try {
      expect(await fail(t.verifier.verify(t.token))).toMatchObject({
        status: 401,
        code: 'TOKEN_EXPIRED',
      });
    } finally {
      clock.advance(-16 * 60_000);
    }
  });

  it('refuses a token whose session is missing or belongs to someone else', async () => {
    const missing = await build({ session: null });
    expect((await fail(missing.verifier.verify(missing.token))).code).toBe('TOKEN_INVALID');
    const foreign = await build({ session: row({ userId: 'user-2' }) });
    expect((await fail(foreign.verifier.verify(foreign.token))).code).toBe('TOKEN_INVALID');
  });

  it('names why an ended session ended', async () => {
    const t = await build({ session: row({ endedAt: new Date(), endReason: 4 }) });
    expect(await fail(t.verifier.verify(t.token))).toMatchObject({
      status: 401,
      code: 'SESSION_ENDED',
      options: { details: { reason: 'admin_revoked' } },
    });
  });

  it('ends a session past its idle or absolute deadline', async () => {
    for (const patch of [
      { idleExpiresAt: new Date(clock.now().getTime() - 1) },
      { absoluteExpiresAt: new Date(clock.now().getTime() - 1) },
    ]) {
      const t = await build({ session: row(patch) });
      expect(await fail(t.verifier.verify(t.token))).toMatchObject({
        code: 'SESSION_ENDED',
        options: { details: { reason: 'expired' } },
      });
      expect(t.repository.endSession).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        6,
        clock.now(),
      );
    }
  });

  it('ends all sessions of a blocked or inactive person', async () => {
    for (const accountStatus of [AccountStatus.Blocked, AccountStatus.Inactive]) {
      const t = await build({ session: row({ accountStatus }) });
      expect(await fail(t.verifier.verify(t.token))).toMatchObject({
        options: { details: { reason: 'blocked' } },
      });
      expect(t.repository.endUserSessions).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        3,
        clock.now(),
      );
    }
  });

  it('ends a session whose grant was revoked, but only for roles that need a grant', async () => {
    const revoked = await build({ granted: false });
    expect(await fail(revoked.verifier.verify(revoked.token))).toMatchObject({
      options: { details: { reason: 'admin_revoked' } },
    });
    for (const activeRoleCode of [null, 4, 5]) {
      const t = await build({ session: row({ activeRoleCode }), granted: false });
      await t.verifier.verify(t.token);
      expect(t.repository.hasGrant).not.toHaveBeenCalled();
    }
  });

  it('moves the idle deadline of a mobile session only after five minutes', async () => {
    const recent = await build({
      session: row({ lastUsedAt: new Date(clock.now().getTime() - 4 * 60_000) }),
    });
    await recent.verifier.verify(recent.token);
    expect(recent.repository.touchSession).not.toHaveBeenCalled();

    const old = await build({
      session: row({ lastUsedAt: new Date(clock.now().getTime() - 5 * 60_000) }),
    });
    await old.verifier.verify(old.token);
    expect(old.repository.touchSession).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      clock.now(),
      new Date(clock.now().getTime() + 30 * 86_400_000),
    );

    const consoleSession = await build({
      session: row({ clientType: 2, lastUsedAt: new Date(0) }),
    });
    await consoleSession.verifier.verify(consoleSession.token);
    expect(consoleSession.repository.touchSession).not.toHaveBeenCalled();
  });
});
