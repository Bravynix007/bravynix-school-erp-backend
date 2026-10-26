import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService, Tx } from '../database/index.js';
import type { AccountDirectory } from './account-directory.js';
import type { AccountRepository, AccountRow } from './account.repository.js';
import type { BackgroundMailer } from './background-mailer.js';
import type { IdentityRepository } from './identity.repository.js';
import type { MfaRepository, TotpFactor } from './mfa.repository.js';
import type { OtpHasher } from './otp-hasher.js';
import { PlatformAccountService } from './platform-account.service.js';
import type { SessionRepository } from './session.repository.js';

const principal = {
  personId: 'admin-1',
  roleCode: 1,
  societyId: null,
  sessionId: 's1',
} as unknown as Principal;

const user = (overrides: Partial<AccountRow> = {}): AccountRow =>
  ({
    id: 'user-1',
    email: 'asha@example.com',
    first_name: 'Asha',
    last_name: null,
    account_status: 1,
    first_login_at: new Date('2026-10-01T00:00:00.000Z'),
    locked_until: null,
    blocked_at: null,
    block_reason: null,
    version: 3,
    ...overrides,
  }) as AccountRow;

const factor = (lockedUntil: Date | null = null): TotpFactor => ({
  secretCiphertext: Buffer.alloc(1),
  confirmedAt: new Date('2026-10-02T00:00:00.000Z'),
  lastUsedStep: null,
  lockedUntil,
});

function build(current: AccountRow | null = user()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const findById = vi.fn<AccountRepository['findById']>().mockResolvedValue(current ?? undefined);
  const update = vi
    .fn<AccountRepository['update']>()
    .mockImplementation((_tx, _id, columns) =>
      Promise.resolve({ ...(current ?? user()), ...columns } as AccountRow),
    );
  const findByEmail = vi.fn<AccountRepository['findByEmail']>().mockResolvedValue(undefined);
  const holdsActiveGrant = vi.fn<AccountRepository['holdsActiveGrant']>().mockResolvedValue(true);
  const activeGrant = vi
    .fn<AccountRepository['activeGrant']>()
    .mockResolvedValue({ id: 'grant-1' } as never);
  const lockSeats = vi.fn<AccountRepository['lockSeats']>().mockResolvedValue();
  const revoke = vi.fn<AccountDirectory['revoke']>().mockResolvedValue(1);
  const grant = vi.fn<AccountDirectory['grant']>();
  const welcome = vi.fn<AccountDirectory['welcome']>();
  const seatHolders = vi.fn<AccountRepository['seatHolders']>().mockResolvedValue([]);
  const confirmedAmong = vi.fn<MfaRepository['confirmedAmong']>().mockResolvedValue(new Set());
  const endUserSessions = vi.fn<SessionRepository['endUserSessions']>().mockResolvedValue(3);
  const findFactor = vi.fn<MfaRepository['findFactor']>().mockResolvedValue(factor());
  const deleteFactor = vi.fn<MfaRepository['deleteFactor']>().mockResolvedValue();
  const spendTokens = vi.fn<MfaRepository['spendTokens']>().mockResolvedValue();
  const clearLock = vi.fn<MfaRepository['clearLock']>().mockResolvedValue();
  const liftLoginLock = vi.fn<IdentityRepository['liftLoginLock']>().mockResolvedValue(false);
  const send = vi.fn<BackgroundMailer['send']>();
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new PlatformAccountService(
    { transaction } as unknown as DatabaseService,
    {
      findById,
      update,
      findByEmail,
      holdsActiveGrant,
      activeGrant,
      lockSeats,
      seatHolders,
    } as unknown as AccountRepository,
    { revoke, grant, welcome } as unknown as AccountDirectory,
    { endUserSessions } as unknown as SessionRepository,
    {
      findFactor,
      deleteFactor,
      spendTokens,
      clearLock,
      confirmedAmong,
    } as unknown as MfaRepository,
    { liftLoginLock } as unknown as IdentityRepository,
    { email: () => Buffer.alloc(32) } as unknown as OtpHasher,
    { send } as unknown as BackgroundMailer,
    { record } as unknown as AuditService,
    new FixedClock('2026-10-26T10:00:00.000Z'),
  );
  return {
    service,
    transaction,
    update,
    findByEmail,
    holdsActiveGrant,
    activeGrant,
    revoke,
    grant,
    welcome,
    seatHolders,
    confirmedAmong,
    endUserSessions,
    findFactor,
    deleteFactor,
    spendTokens,
    clearLock,
    liftLoginLock,
    send,
    record,
  };
}

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('listSuperAdmins (PLT-12)', () => {
  it('lists the holders by seat with whether each has a confirmed authenticator, unpaged', async () => {
    const t = build();
    t.seatHolders.mockResolvedValue([
      { user: user({ id: 'a' }), seatNo: 1, grantedAt: new Date('2026-10-01T00:00:00.000Z') },
      { user: user({ id: 'b' }), seatNo: 2, grantedAt: new Date('2026-10-02T00:00:00.000Z') },
    ]);
    t.confirmedAmong.mockResolvedValue(new Set(['b']));
    const result = await t.service.listSuperAdmins(principal);
    expect(result.options.meta).toBeNull();
    expect(result.data.map((admin) => [admin.id, admin.seatNo, admin.authenticatorSetUp])).toEqual([
      ['a', 1, false],
      ['b', 2, true],
    ]);
  });
});

describe('addSuperAdmin (PLT-13)', () => {
  it('grants the seat in the platform context, audits it masked, then welcomes them', async () => {
    const t = build(user({ id: 'new-1', email: 'meena@example.com' }));
    t.grant.mockResolvedValue({
      id: 'new-1',
      email: 'meena@example.com',
      displayName: 'Meena',
      seatNo: 3,
      created: true,
    });
    t.confirmedAmong.mockResolvedValue(new Set());
    const added = await t.service.addSuperAdmin(principal, { email: 'meena@example.com' });
    expect(t.grant).toHaveBeenCalledWith(
      expect.anything(),
      { roleCode: 1, societyId: null },
      { email: 'meena@example.com' },
      'admin-1',
      expect.any(Date),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'super_admin.add',
        societyId: null,
        after: { email: 'm***@example.com', seat_no: 3 },
      }),
    );
    expect(t.welcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-1' }),
      { roleCode: 1, societyId: null },
      null,
    );
    expect(added).toMatchObject({ id: 'new-1', seatNo: 3, authenticatorSetUp: false });
  });
});

describe('removeSuperAdmin (PLT-14)', () => {
  it('never lets an administrator remove themself', async () => {
    const t = build();
    const error = await refusal(t.service.removeSuperAdmin(principal, 'admin-1'));
    expect(error).toMatchObject({ status: 409, code: 'CANNOT_ACT_ON_SELF' });
    expect(t.transaction).not.toHaveBeenCalled();
  });

  it('refuses a caller whose own grant ended meanwhile, so two cannot remove each other', async () => {
    const t = build();
    t.activeGrant.mockResolvedValue(undefined);
    expect(await refusal(t.service.removeSuperAdmin(principal, 'user-1'))).toMatchObject({
      status: 403,
    });
    expect(t.revoke).not.toHaveBeenCalled();
  });

  it('revokes the grant and audits how many sessions ended', async () => {
    const t = build();
    await expect(t.service.removeSuperAdmin(principal, 'user-1')).resolves.toEqual({
      id: 'user-1',
      status: 0,
    });
    expect(t.revoke).toHaveBeenCalledWith(
      expect.anything(),
      { roleCode: 1, societyId: null },
      'user-1',
      'admin-1',
      'super_admin_removed',
      expect.any(Date),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'super_admin.remove',
        entityId: 'user-1',
        societyId: null,
      }),
    );
  });
});

describe('block (PLT-15)', () => {
  it('answers a stale version before anything else', async () => {
    const t = build();
    const error = await refusal(t.service.block(principal, 'admin-1', { version: 2, reason: 'x' }));
    expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });

  it('answers 404 for an unknown person and refuses blocking yourself', async () => {
    expect(
      await refusal(build(null).service.block(principal, 'user-1', { version: 3, reason: 'x' })),
    ).toMatchObject({ status: 404 });
    expect(
      await refusal(
        build(user({ id: 'admin-1' })).service.block(principal, 'admin-1', {
          version: 3,
          reason: 'x',
        }),
      ),
    ).toMatchObject({ code: 'CANNOT_ACT_ON_SELF' });
  });

  it.each([0, 2])('refuses an account whose status is %i', async (status) => {
    const t = build(user({ account_status: status }));
    expect(
      await refusal(t.service.block(principal, 'user-1', { version: 3, reason: 'x' })),
    ).toMatchObject({
      status: 409,
      code: 'INVALID_STATE',
    });
  });

  it('blocks, ends every session, audits the reason and tells the person', async () => {
    const t = build();
    const blocked = await t.service.block(principal, 'user-1', {
      version: 3,
      reason: 'Left school',
    });
    expect(blocked).toMatchObject({ accountStatus: 2, blockReason: 'Left school' });
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({
        account_status: 2,
        blocked_by: 'admin-1',
        block_reason: 'Left school',
      }),
    );
    expect(t.endUserSessions).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      3,
      expect.any(Date),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'account.block', reason: 'Left school' }),
    );
    expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'account-blocked' }));
  });
});

describe('unblock (PLT-16)', () => {
  it('refuses a person who is not blocked', async () => {
    const t = build();
    expect(await refusal(t.service.unblock(principal, 'user-1', { version: 3 }))).toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('returns a person who never signed in to Pending, and the rest to Active', async () => {
    const never = build(user({ account_status: 2, first_login_at: null }));
    await never.service.unblock(principal, 'user-1', { version: 3 });
    expect(never.update).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ account_status: 3, blocked_at: null, block_reason: null }),
    );
    const before = build(user({ account_status: 2 }));
    await before.service.unblock(principal, 'user-1', { version: 3 });
    expect(before.update).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ account_status: 1 }),
    );
  });
});

describe('changeEmail (PLT-17)', () => {
  const body = { email: 'New@Example.com', version: 3 };

  it('answers 404 for a person who is neither an Owner nor a Super Admin', async () => {
    const t = build();
    t.holdsActiveGrant.mockResolvedValue(false);
    expect(await refusal(t.service.changeEmail(principal, 'user-1', body))).toMatchObject({
      status: 404,
    });
  });

  it('refuses your own email, and an email that belongs to another person', async () => {
    expect(
      await refusal(build(user({ id: 'admin-1' })).service.changeEmail(principal, 'admin-1', body)),
    ).toMatchObject({ code: 'CANNOT_ACT_ON_SELF' });
    const taken = build();
    taken.findByEmail.mockResolvedValue(user({ id: 'other' }));
    expect(await refusal(taken.service.changeEmail(principal, 'user-1', body))).toMatchObject({
      status: 409,
      code: 'EMAIL_IN_USE',
    });
  });

  it('writes nothing for the same email', async () => {
    const t = build();
    await t.service.changeEmail(principal, 'user-1', { email: 'ASHA@example.com', version: 3 });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
  });

  it('changes the email at once: sessions and open steps end, both addresses are told, the audit is masked', async () => {
    const t = build();
    const changed = await t.service.changeEmail(principal, 'user-1', body);
    expect(changed.email).toBe('new@example.com');
    expect(t.endUserSessions).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      7,
      expect.any(Date),
    );
    expect(t.spendTokens).toHaveBeenCalled();
    expect(t.send.mock.calls.map(([mail]) => mail.to)).toEqual([
      'asha@example.com',
      'new@example.com',
    ]);
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'account.email_change',
        before: { email: 'a***@example.com' },
        after: expect.objectContaining({ email: 'n***@example.com' }),
      }),
    );
  });

  it('tells the loser of a race on the new email that it is taken', async () => {
    const t = build();
    t.update.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_users_email' }),
    );
    expect(await refusal(t.service.changeEmail(principal, 'user-1', body))).toMatchObject({
      code: 'EMAIL_IN_USE',
    });
  });
});

describe('resetAuthenticator (PLT-18)', () => {
  it('refuses yourself, a person who is not a Super Admin, and one with no authenticator', async () => {
    expect(
      await refusal(
        build(user({ id: 'admin-1' })).service.resetAuthenticator(principal, 'admin-1'),
      ),
    ).toMatchObject({ code: 'CANNOT_ACT_ON_SELF' });
    const notAdmin = build();
    notAdmin.activeGrant.mockResolvedValue(undefined);
    expect(await refusal(notAdmin.service.resetAuthenticator(principal, 'user-1'))).toMatchObject({
      status: 404,
    });
    const none = build();
    none.findFactor.mockResolvedValue(undefined);
    expect(await refusal(none.service.resetAuthenticator(principal, 'user-1'))).toMatchObject({
      code: 'MFA_NOT_ENROLLED',
    });
  });

  it('is refused while the lock is active, and not after it has lapsed', async () => {
    const locked = build();
    locked.findFactor.mockResolvedValue(factor(new Date('2026-10-27T10:00:00.000Z')));
    expect(await refusal(locked.service.resetAuthenticator(principal, 'user-1'))).toMatchObject({
      status: 409,
      code: 'AUTHENTICATOR_LOCKED',
      options: { details: { lockedUntil: '2026-10-27T10:00:00.000Z' } },
    });
    expect(locked.deleteFactor).not.toHaveBeenCalled();

    const lapsed = build();
    lapsed.findFactor.mockResolvedValue(factor(new Date('2026-10-26T09:00:00.000Z')));
    await expect(lapsed.service.resetAuthenticator(principal, 'user-1')).resolves.toEqual({
      id: 'user-1',
      authenticatorSetUp: false,
    });
  });

  it('removes the authenticator, ends the sessions and open steps, audits it and tells the person', async () => {
    const t = build();
    await t.service.resetAuthenticator(principal, 'user-1');
    expect(t.deleteFactor).toHaveBeenCalledWith(expect.anything(), 'user-1');
    expect(t.spendTokens).toHaveBeenCalled();
    expect(t.endUserSessions).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      4,
      expect.any(Date),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'mfa.reset' }),
    );
    expect(t.send).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'authenticator-reset' }),
    );
  });
});

describe('unlock (PLT-41)', () => {
  it('refuses when nothing is locked', async () => {
    const t = build();
    expect(await refusal(t.service.unlock(principal, 'user-1', { reason: 'x' }))).toMatchObject({
      status: 409,
      code: 'NOT_LOCKED',
    });
    expect(t.record).not.toHaveBeenCalled();
  });

  it('lifts a login lock alone', async () => {
    const t = build();
    t.liftLoginLock.mockResolvedValue(true);
    await expect(
      t.service.unlock(principal, 'user-1', { reason: 'Rang the office' }),
    ).resolves.toEqual({
      id: 'user-1',
      loginLockCleared: true,
      authenticatorLockCleared: false,
    });
    expect(t.clearLock).not.toHaveBeenCalled();
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'account.unlock', reason: 'Rang the office' }),
    );
  });

  it('lifts an authenticator lock alone, and ignores one that lapsed', async () => {
    const t = build();
    t.findFactor.mockResolvedValue(factor(new Date('2026-10-27T10:00:00.000Z')));
    await expect(t.service.unlock(principal, 'user-1', { reason: 'x' })).resolves.toMatchObject({
      loginLockCleared: false,
      authenticatorLockCleared: true,
    });
    expect(t.clearLock).toHaveBeenCalledWith(expect.anything(), 'user-1');

    const lapsed = build();
    lapsed.findFactor.mockResolvedValue(factor(new Date('2026-10-26T09:00:00.000Z')));
    expect(
      await refusal(lapsed.service.unlock(principal, 'user-1', { reason: 'x' })),
    ).toMatchObject({
      code: 'NOT_LOCKED',
    });
  });
});
