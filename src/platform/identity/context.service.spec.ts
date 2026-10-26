import type { Principal } from '../../common/auth/access-token-verifier.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService } from '../database/index.js';
import { AccountStatus } from './auth-codes.js';
import { ContextService } from './context.service.js';
import type { IdentityRepository, LoginUser } from './identity.repository.js';
import type { Grant, SessionRepository, SessionRow } from './session.repository.js';
import { TokenService } from './token.service.js';

/** The rules of AUTH-06 and ME-01 with the database replaced; the SQL is covered by the integration tests. */
const tokens = new TokenService(undefined, 'k1', 'a'.repeat(32));
const SOCIETY = '0192b0e0-0000-7000-8000-0000000000a1';
const OTHER = '0192b0e0-0000-7000-8000-0000000000b1';

const user: LoginUser = {
  id: 'user-1',
  email: 'asha@two-worlds.test',
  firstName: 'Asha',
  lastName: 'Rao',
  accountStatus: AccountStatus.Pending,
  preferredLanguage: 'en',
  lockedUntil: null,
};
const principal = (patch: Partial<Principal> = {}): Principal => ({
  personId: 'user-1',
  sessionId: 'session-1',
  roleCode: null,
  societyId: null,
  clientType: 'mobile',
  viaSupportAccess: false,
  ...patch,
});

function build(
  grants: Grant[],
  found: LoginUser | null = user,
  options: { moved?: boolean; ended?: SessionRow } = {},
) {
  const clock = new FixedClock();
  const sessions = {
    activeGrants: vi.fn<SessionRepository['activeGrants']>(async () => grants),
    setActiveContext: vi.fn<SessionRepository['setActiveContext']>(
      async () => options.moved ?? true,
    ),
    findSession: vi.fn<SessionRepository['findSession']>(async () => options.ended),
  };
  const identity = {
    findUserById: vi.fn<IdentityRepository['findUserById']>(async () => found ?? undefined),
  };
  const record = vi.fn<AuditService['record']>(async () => 'audit-id');
  const service = new ContextService(
    {
      db: {},
      transaction: (_tenant: unknown, work: (tx: unknown) => unknown) => work({}),
    } as DatabaseService,
    identity as unknown as IdentityRepository,
    sessions as unknown as SessionRepository,
    { record } as unknown as AuditService,
    clock,
    tokens,
  );
  return { service, sessions, record, clock };
}

const fail = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { status: number; code: string; options: { errors?: { field: string; code: string }[] } };

const owner: Grant = { roleCode: 2, societyId: SOCIETY, institutionId: null };
const admin: Grant = { roleCode: 3, societyId: OTHER, institutionId: 'ins-1' };

describe('ContextService.me', () => {
  it('reports the person, the active context and the mobile contexts', async () => {
    const t = build([owner, admin]);
    const me = await t.service.me(principal({ roleCode: 2, societyId: SOCIETY }));
    expect(me).toMatchObject({
      userType: 2,
      userTypeName: 'society_owner',
      session: { id: 'session-1', activeContext: { roleCode: 2, societyId: SOCIETY } },
      // A Pending account is shown as Active, as at login.
      person: { id: 'user-1', email: user.email, accountStatus: 1 },
      contexts: [
        { roleCode: 2, societyId: SOCIETY },
        { roleCode: 3, societyId: OTHER },
      ],
      requiredNotices: [],
    });
  });

  it('has no active context before one is chosen', async () => {
    const me = await build([owner, admin]).service.me(principal());
    expect(me).toMatchObject({ userType: null, session: { activeContext: null } });
  });

  it('shows the console its one Super Admin context only', async () => {
    const sa: Grant = { roleCode: 1, societyId: null, institutionId: null };
    const consoleView = await build([sa, owner]).service.me(
      principal({ clientType: 'console', roleCode: 1 }),
    );
    expect(consoleView.contexts).toEqual([{ roleCode: 1, societyId: null }]);
    const none = await build([owner]).service.me(principal({ clientType: 'console', roleCode: 1 }));
    expect(none.contexts).toEqual([]);
  });

  it('refuses a token whose person no longer exists', async () => {
    const error = await fail(build([], null).service.me(principal()));
    expect(error).toMatchObject({ status: 401 });
  });
});

describe('ContextService.switchContext', () => {
  it('moves the session, audits it and signs a token for the new context', async () => {
    const t = build([owner, admin]);
    const result = await t.service.switchContext(principal({ roleCode: 2, societyId: SOCIETY }), {
      roleCode: 3,
      societyId: OTHER,
    });
    expect(t.sessions.setActiveContext).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      3,
      OTHER,
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'auth.context_switch',
        entityId: 'user-1',
        before: { roleCode: 2, societyId: SOCIETY },
        after: { roleCode: 3, societyId: OTHER },
      }),
    );
    expect(result).toMatchObject({
      userType: 3,
      userTypeName: 'institution_admin',
      activeContext: { roleCode: 3, societyId: OTHER },
    });
    const check = await tokens.checkAccessToken(result.accessToken, t.clock.now());
    expect(check).toMatchObject({
      claims: { roleCode: 3, societyId: OTHER, sessionId: 'session-1' },
    });
  });

  it('refuses a role without a grant, the Super Admin grant on mobile, and roles 4 and 5 for now', async () => {
    const sa: Grant = { roleCode: 1, societyId: null, institutionId: null };
    const t = build([owner, sa]);
    for (const body of [
      { roleCode: 3, societyId: SOCIETY },
      { roleCode: 2, societyId: OTHER },
      { roleCode: 4, societyId: SOCIETY },
      { roleCode: 5 },
    ]) {
      expect(await fail(t.service.switchContext(principal(), body))).toMatchObject({
        status: 403,
        code: 'CONTEXT_NOT_AVAILABLE',
      });
    }
    expect(t.sessions.setActiveContext).not.toHaveBeenCalled();
  });

  it('answers SESSION_ENDED, with the reason, when the session ended a moment ago', async () => {
    const ended = { endReason: 1 } as SessionRow;
    const t = build([owner], user, { moved: false, ended });
    const error = await fail(
      t.service.switchContext(principal({ roleCode: 2, societyId: SOCIETY }), {
        roleCode: 2,
        societyId: SOCIETY,
      }),
    );
    expect(error).toMatchObject({
      status: 401,
      code: 'SESSION_ENDED',
      options: { details: { reason: 'logout' } },
    });
    expect(t.record).not.toHaveBeenCalled();
  });

  it('refuses a console session before it looks at anything else', async () => {
    const t = build([owner]);
    const error = await fail(
      t.service.switchContext(principal({ clientType: 'console', roleCode: 1 }), {
        roleCode: 2,
        societyId: SOCIETY,
      }),
    );
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(t.sessions.activeGrants).not.toHaveBeenCalled();
  });

  it('treats a null societyId as absent: required for roles 2 to 4, fine for role 5', async () => {
    const t = build([owner]);
    const missing = await fail(
      t.service.switchContext(principal(), { roleCode: 2, societyId: null }),
    );
    expect(missing).toMatchObject({
      status: 400,
      options: { errors: [{ field: 'societyId', code: 'REQUIRED' }] },
    });
    // Role 5 is never available yet, but a null Society is not what refuses it.
    const parent = await fail(
      t.service.switchContext(principal(), { roleCode: 5, societyId: null }),
    );
    expect(parent).toMatchObject({ status: 403, code: 'CONTEXT_NOT_AVAILABLE' });
  });

  it('asks for a Society on roles 2 to 4 and forbids one on role 5', async () => {
    const t = build([owner]);
    const missing = await fail(t.service.switchContext(principal(), { roleCode: 2 }));
    expect(missing).toMatchObject({
      status: 400,
      options: { errors: [{ field: 'societyId', code: 'REQUIRED' }] },
    });
    const extra = await fail(
      t.service.switchContext(principal(), { roleCode: 5, societyId: SOCIETY }),
    );
    expect(extra).toMatchObject({
      status: 400,
      options: { errors: [{ field: 'societyId', code: 'FIELD_NOT_ALLOWED' }] },
    });
  });
});
