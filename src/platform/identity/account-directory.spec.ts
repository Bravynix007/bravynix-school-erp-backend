import type { Tx } from '../database/index.js';
import { AccountDirectory, type SeatKind } from './account-directory.js';
import type { AccountRow, AccountRepository } from './account.repository.js';
import type { BackgroundMailer } from './background-mailer.js';
import type { MfaRepository } from './mfa.repository.js';
import type { SessionRepository } from './session.repository.js';

const tx = {} as Tx;
const now = new Date('2026-10-26T10:00:00.000Z');
const owner: SeatKind = { roleCode: 2, societyId: 'society-1' };
const superAdmin: SeatKind = { roleCode: 1, societyId: null };

const user = (overrides: Partial<AccountRow> = {}): AccountRow =>
  ({
    id: 'user-1',
    email: 'asha@example.com',
    first_name: 'Asha',
    last_name: null,
    account_status: 1,
    ...overrides,
  }) as AccountRow;

function build(existing?: AccountRow, taken: number[] = []) {
  const lockSeats = vi.fn<AccountRepository['lockSeats']>().mockResolvedValue();
  const lockRoleSeparation = vi.fn<AccountRepository['lockRoleSeparation']>().mockResolvedValue();
  const holdsActiveGrant = vi.fn<AccountRepository['holdsActiveGrant']>().mockResolvedValue(false);
  const holdsGrantOrRestorable = vi
    .fn<AccountRepository['holdsGrantOrRestorable']>()
    .mockResolvedValue(false);
  const holdsStaffRecord = vi.fn<SessionRepository['holdsStaffRecord']>().mockResolvedValue(false);
  const holdsGuardianRecord = vi
    .fn<SessionRepository['holdsGuardianRecord']>()
    .mockResolvedValue(false);
  const findByEmail = vi.fn<AccountRepository['findByEmail']>().mockResolvedValue(existing);
  const insertPending = vi
    .fn<AccountRepository['insertPending']>()
    .mockResolvedValue(user({ id: 'new-1', first_name: null, account_status: 3 }));
  const activeGrant = vi.fn<AccountRepository['activeGrant']>().mockResolvedValue(undefined);
  const takenSeats = vi.fn<AccountRepository['takenSeats']>().mockResolvedValue(taken);
  const insertGrant = vi.fn<AccountRepository['insertGrant']>().mockResolvedValue();
  const revokeGrant = vi.fn<AccountRepository['revokeGrant']>().mockResolvedValue();
  const endRoleSessions = vi.fn<AccountRepository['endRoleSessions']>().mockResolvedValue(2);
  const send = vi.fn<BackgroundMailer['send']>();
  const directory = new AccountDirectory(
    {
      lockSeats,
      lockRoleSeparation,
      holdsActiveGrant,
      holdsGrantOrRestorable,
      findByEmail,
      insertPending,
      activeGrant,
      takenSeats,
      insertGrant,
      revokeGrant,
      endRoleSessions,
    } as unknown as AccountRepository,
    { holdsStaffRecord, holdsGuardianRecord } as unknown as SessionRepository,
    {} as MfaRepository,
    { send } as unknown as BackgroundMailer,
  );
  return {
    directory,
    lockSeats,
    lockRoleSeparation,
    holdsActiveGrant,
    holdsGrantOrRestorable,
    holdsStaffRecord,
    holdsGuardianRecord,
    findByEmail,
    insertPending,
    activeGrant,
    insertGrant,
    revokeGrant,
    endRoleSessions,
    send,
  };
}

describe('AccountDirectory.grant', () => {
  it('makes a Pending account for a new email, in the lowest free seat, under the seat lock', async () => {
    const t = build(undefined, [1]);
    const granted = await t.directory.grant(
      tx,
      owner,
      { email: 'New@Example.com', firstName: 'Ravi' },
      'admin-1',
      now,
    );
    expect(t.lockSeats).toHaveBeenCalledWith(tx, 2, 'society-1');
    expect(t.insertPending).toHaveBeenCalledWith(
      tx,
      { email: 'new@example.com', firstName: 'Ravi', lastName: null },
      'admin-1',
    );
    expect(t.insertGrant).toHaveBeenCalledWith(tx, {
      userId: 'new-1',
      roleCode: 2,
      societyId: 'society-1',
      seatNo: 2,
      by: 'admin-1',
      now,
    });
    expect(granted).toEqual({
      id: 'new-1',
      email: 'asha@example.com',
      displayName: 'asha@example.com',
      seatNo: 2,
      created: true,
    });
  });

  it('gives an email that already belongs to a person the role, without touching their names', async () => {
    const t = build(user());
    const granted = await t.directory.grant(
      tx,
      superAdmin,
      { email: 'asha@example.com', firstName: 'Other' },
      'admin-1',
      now,
    );
    expect(t.insertPending).not.toHaveBeenCalled();
    expect(granted).toMatchObject({ id: 'user-1', displayName: 'Asha', created: false });
  });

  it.each([
    ['a Society Owner as Super Admin', superAdmin, 2],
    ['a Super Admin as Society Owner', owner, 1],
  ])('refuses %s: the two roles are never one person', async (_name, kind, held) => {
    const t = build(user());
    t.holdsActiveGrant.mockResolvedValue(true);
    await expect(
      t.directory.grant(tx, kind, { email: 'asha@example.com' }, 'admin-1', now),
    ).rejects.toMatchObject({ status: 409, code: 'ROLE_CONFLICT' });
    expect(t.holdsActiveGrant).toHaveBeenCalledWith(tx, 'user-1', [held]);
    expect(t.insertGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['an Institution Admin, active or dormant', 'holdsGrantOrRestorable'],
    ['staff, in any Society, active or dormant', 'holdsStaffRecord'],
    ['a guardian of a student, in any Society', 'holdsGuardianRecord'],
  ] as const)(
    'refuses %s as Super Admin: the platform team holds no school role',
    async (_name, which) => {
      const t = build(user());
      t[which].mockResolvedValue(true);
      await expect(
        t.directory.grant(tx, superAdmin, { email: 'asha@example.com' }, 'admin-1', now),
      ).rejects.toMatchObject({ status: 409, code: 'ROLE_CONFLICT' });
      expect(t.holdsGrantOrRestorable).toHaveBeenCalledWith(
        tx,
        'user-1',
        [3],
        ['society_deactivated', 'institution_deactivated'],
      );
      expect(t.insertGrant).not.toHaveBeenCalled();
    },
  );

  it('lets an Owner or a teacher hold the other school roles: only a Super Admin is kept apart from them', async () => {
    const t = build(user());
    t.holdsGrantOrRestorable.mockResolvedValue(true);
    t.holdsStaffRecord.mockResolvedValue(true);
    await t.directory.grant(tx, owner, { email: 'asha@example.com' }, 'admin-1', now);
    expect(t.insertGrant).toHaveBeenCalledTimes(1);
    expect(t.holdsGrantOrRestorable).not.toHaveBeenCalled();
    expect(t.holdsStaffRecord).not.toHaveBeenCalled();
  });

  it('checks the other role under the separation lock, after the seat lock', async () => {
    const t = build(user());
    await t.directory.grant(tx, owner, { email: 'asha@example.com' }, 'admin-1', now);
    expect(t.lockRoleSeparation).toHaveBeenCalledWith(tx);
    expect(t.lockSeats.mock.invocationCallOrder[0]).toBeLessThan(
      t.lockRoleSeparation.mock.invocationCallOrder[0] ?? 0,
    );
    expect(t.lockRoleSeparation.mock.invocationCallOrder[0]).toBeLessThan(
      t.holdsActiveGrant.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('takes the separation lock before it looks the email up, even for a new one', async () => {
    const t = build(undefined);
    await t.directory.grant(tx, owner, { email: 'new@example.com' }, 'admin-1', now);
    expect(t.lockRoleSeparation).toHaveBeenCalledWith(tx);
    expect(t.lockRoleSeparation.mock.invocationCallOrder[0]).toBeLessThan(
      t.findByEmail.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('refuses a blocked person, a person who already holds the seat kind, and a full set of seats', async () => {
    await expect(
      build(user({ account_status: 2 })).directory.grant(
        tx,
        owner,
        { email: 'a@example.com' },
        'admin-1',
        now,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'ACCOUNT_BLOCKED' });

    const holder = build(user());
    holder.activeGrant.mockResolvedValue({ id: 'grant-1' } as never);
    await expect(
      holder.directory.grant(tx, owner, { email: 'asha@example.com' }, 'admin-1', now),
    ).rejects.toMatchObject({
      status: 409,
      code: 'DUPLICATE',
      options: { errors: [expect.objectContaining({ field: 'email' })] },
    });

    await expect(
      build(undefined, [1, 2, 3]).directory.grant(
        tx,
        owner,
        { email: 'a@example.com' },
        'admin-1',
        now,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'SEAT_LIMIT_REACHED' });
  });

  it('tells the loser of a race on a new email that the email is taken', async () => {
    const t = build();
    t.insertPending.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_users_email' }),
    );
    await expect(
      t.directory.grant(tx, owner, { email: 'a@example.com' }, 'admin-1', now),
    ).rejects.toMatchObject({ status: 409, code: 'EMAIL_IN_USE' });
  });
});

describe('AccountDirectory.revoke', () => {
  it('revokes the grant and ends the sessions acting in it', async () => {
    const t = build();
    t.activeGrant.mockResolvedValue({ id: 'grant-1' } as never);
    await expect(
      t.directory.revoke(tx, owner, 'user-1', 'admin-1', 'owner_removed', now),
    ).resolves.toBe(2);
    expect(t.revokeGrant).toHaveBeenCalledWith(tx, 'grant-1', 'admin-1', 'owner_removed', now);
    expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 2, 'society-1', 4, now);
  });

  it('refuses the only holder with the given code, and revokes when another holds a seat', async () => {
    const only = build(undefined, [1]);
    only.activeGrant.mockResolvedValue({ id: 'grant-1' } as never);
    await expect(
      only.directory.revoke(tx, owner, 'user-1', 'admin-1', 'x', now, 'LAST_OWNER'),
    ).rejects.toMatchObject({ status: 409, code: 'LAST_OWNER' });
    expect(only.revokeGrant).not.toHaveBeenCalled();

    const two = build(undefined, [1, 2]);
    two.activeGrant.mockResolvedValue({ id: 'grant-1' } as never);
    await expect(
      two.directory.revoke(tx, owner, 'user-1', 'admin-1', 'x', now, 'LAST_OWNER'),
    ).resolves.toBe(2);
  });

  it('answers 404 for a person who is not the holder before it counts the seats', async () => {
    const t = build(undefined, [1]);
    await expect(
      t.directory.revoke(tx, owner, 'user-1', 'admin-1', 'x', now, 'LAST_OWNER'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers 404 when the person does not hold the role', async () => {
    const t = build();
    await expect(
      t.directory.revoke(tx, owner, 'user-1', 'admin-1', 'x', now),
    ).rejects.toMatchObject({ status: 404 });
    expect(t.revokeGrant).not.toHaveBeenCalled();
  });
});

describe('AccountDirectory.endStaffAccessSessions', () => {
  it('ends the sessions acting as Institution Admin and as Teacher / Staff in the Society, reading blocked', async () => {
    const t = build();
    t.endRoleSessions.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    await expect(t.directory.endStaffAccessSessions(tx, 'user-1', 'society-1', now)).resolves.toBe(
      3,
    );
    expect(t.endRoleSessions).toHaveBeenCalledTimes(2);
    expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 3, 'society-1', 3, now);
    expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 4, 'society-1', 3, now);
  });
});

describe('AccountDirectory.welcome', () => {
  it('sends the welcome mail naming the role and the Society', () => {
    const t = build();
    t.directory.welcome(
      { id: 'u', email: 'a@example.com', displayName: 'A', seatNo: 1, created: true },
      owner,
      'Sunrise',
    );
    expect(t.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@example.com', template: 'welcome' }),
    );
  });
});

describe('AccountDirectory.linkStaff', () => {
  it('makes a Pending account for a new email, taking no seat', async () => {
    const t = build(undefined);
    const linked = await t.directory.linkStaff(
      tx,
      { email: 'New@Example.com', firstName: 'Ravi' },
      'admin-1',
    );
    expect(t.insertPending).toHaveBeenCalledWith(
      tx,
      { email: 'new@example.com', firstName: 'Ravi', lastName: null },
      'admin-1',
    );
    expect(linked).toMatchObject({ id: 'new-1', created: true });
    expect(t.lockSeats).not.toHaveBeenCalled();
    expect(t.insertGrant).not.toHaveBeenCalled();
  });

  it('links the person an email already belongs to, and makes no second account', async () => {
    const t = build(user());
    const linked = await t.directory.linkStaff(tx, { email: 'asha@example.com' }, 'admin-1');
    expect(linked).toEqual({
      id: 'user-1',
      email: 'asha@example.com',
      displayName: 'Asha',
      created: false,
    });
    expect(t.insertPending).not.toHaveBeenCalled();
  });

  it('refuses a Super Admin, under the separation lock', async () => {
    const t = build(user());
    t.holdsActiveGrant.mockResolvedValue(true);
    await expect(
      t.directory.linkStaff(tx, { email: 'asha@example.com' }, 'admin-1'),
    ).rejects.toMatchObject({ status: 409, code: 'ROLE_CONFLICT' });
    expect(t.lockRoleSeparation).toHaveBeenCalled();
    expect(t.holdsActiveGrant).toHaveBeenCalledWith(tx, 'user-1', [1]);
  });

  it.each([
    [2, 'ACCOUNT_BLOCKED'],
    [0, 'INVALID_STATE'],
  ])('refuses a person whose account status is %s with 409 %s', async (status, code) => {
    const t = build(user({ account_status: status }));
    await expect(
      t.directory.linkStaff(tx, { email: 'asha@example.com' }, 'admin-1'),
    ).rejects.toMatchObject({ status: 409, code });
  });

  it('ends only the sessions in the role and Society, and says why', async () => {
    const t = build();
    expect(await t.directory.endRoleSessions(tx, 'user-1', 4, 'society-1', now)).toBe(2);
    expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 4, 'society-1', 4, now);
  });

  it('sends the welcome for a role without a seat', () => {
    const t = build();
    t.directory.welcomeAs({ email: 'asha@example.com' }, 4, 'Sunrise Trust');
    expect(t.send.mock.calls[0]![0]).toMatchObject({
      to: 'asha@example.com',
      template: 'welcome',
      variables: { role: 'Teacher', society: 'Sunrise Trust' },
    });
  });
});

describe('AccountDirectory.linkGuardian', () => {
  it('makes a Pending account for a new email, taking no seat', async () => {
    const t = build(undefined);
    const linked = await t.directory.linkGuardian(
      tx,
      { email: 'Parent@Example.com', firstName: 'Ravi', lastName: 'Shetty' },
      'admin-1',
    );
    expect(t.insertPending).toHaveBeenCalledWith(
      tx,
      { email: 'parent@example.com', firstName: 'Ravi', lastName: 'Shetty' },
      'admin-1',
    );
    expect(linked).toMatchObject({ id: 'new-1', created: true });
    expect(t.lockSeats).not.toHaveBeenCalled();
    expect(t.insertGrant).not.toHaveBeenCalled();
  });

  it('links the person an email already belongs to, so one parent has several children', async () => {
    const t = build(user());
    const linked = await t.directory.linkGuardian(tx, { email: 'asha@example.com' }, 'admin-1');
    expect(linked).toMatchObject({ id: 'user-1', created: false });
    expect(t.insertPending).not.toHaveBeenCalled();
  });

  it('refuses a Super Admin, under the separation lock', async () => {
    const t = build(user());
    t.holdsActiveGrant.mockResolvedValue(true);
    await expect(
      t.directory.linkGuardian(tx, { email: 'asha@example.com' }, 'admin-1'),
    ).rejects.toMatchObject({ status: 409, code: 'ROLE_CONFLICT' });
    expect(t.lockRoleSeparation).toHaveBeenCalled();
    expect(t.holdsActiveGrant).toHaveBeenCalledWith(tx, 'user-1', [1]);
  });

  it('links a teacher or an Owner: a parent may hold any role but Super Admin', async () => {
    const t = build(user());
    t.holdsStaffRecord.mockResolvedValue(true);
    const linked = await t.directory.linkGuardian(tx, { email: 'asha@example.com' }, 'admin-1');
    expect(linked).toMatchObject({ id: 'user-1', created: false });
  });

  it.each([
    [2, 'ACCOUNT_BLOCKED'],
    [0, 'INVALID_STATE'],
  ])('refuses a person whose account status is %s with 409 %s', async (status, code) => {
    const t = build(user({ account_status: status }));
    await expect(
      t.directory.linkGuardian(tx, { email: 'asha@example.com' }, 'admin-1'),
    ).rejects.toMatchObject({ status: 409, code });
  });

  it('sends the welcome as Parent', () => {
    const t = build();
    t.directory.welcomeAs({ email: 'asha@example.com' }, 5, 'Sunrise Trust');
    expect(t.send.mock.calls[0]![0]).toMatchObject({
      variables: { role: 'Parent', society: 'Sunrise Trust' },
    });
  });
});

const request = (overrides: Partial<Parameters<AccountDirectory['changeStaffEmail']>[1]> = {}) => ({
  staffMemberId: 'staff-1',
  userId: 'user-1',
  societyId: 'society-1',
  email: 'New@Example.com',
  names: { firstName: 'Asha', lastName: 'Rao' },
  by: 'admin-1',
  now,
  vet: vi.fn<(personId: string) => Promise<void>>().mockResolvedValue(),
  ...overrides,
});

function change(
  options: {
    existing?: AccountRow;
    grant?: boolean;
    staffElsewhere?: boolean;
    staffHere?: boolean;
    guardianLinks?: number;
    adminGrants?: { id: string; user_id: string; society_id: string; institution_id: string }[];
  } = {},
) {
  const adminGrantsOfStaff = vi
    .fn<AccountRepository['adminGrantsOfStaff']>()
    .mockResolvedValue(
      (options.adminGrants ?? []).map((grant) => ({ revoked_at: null, ...grant })) as never,
    );
  const restampRevokeReason = vi.fn<AccountRepository['restampRevokeReason']>().mockResolvedValue();
  const revokeGrant = vi.fn<AccountRepository['revokeGrant']>().mockResolvedValue();
  const findById = vi.fn<AccountRepository['findById']>().mockResolvedValue(user());
  const findByEmail = vi.fn<AccountRepository['findByEmail']>().mockResolvedValue(options.existing);
  const update = vi
    .fn<AccountRepository['update']>()
    .mockResolvedValue(user({ email: 'new@example.com' }));
  const insertPending = vi
    .fn<AccountRepository['insertPending']>()
    .mockResolvedValue(user({ id: 'new-1', email: 'new@example.com', first_name: 'Asha' }));
  const holdsActiveGrant = vi.fn<AccountRepository['holdsActiveGrant']>().mockResolvedValue(false);
  const holdsGrantOrRestorable = vi
    .fn<AccountRepository['holdsGrantOrRestorable']>()
    .mockResolvedValue(options.grant ?? false);
  const endRoleSessions = vi.fn<AccountRepository['endRoleSessions']>().mockResolvedValue(1);
  const lockRoleSeparation = vi.fn<AccountRepository['lockRoleSeparation']>().mockResolvedValue();
  const endUserSessions = vi.fn<SessionRepository['endUserSessions']>().mockResolvedValue(3);
  const hasStaffElsewhere = vi
    .fn<SessionRepository['hasStaffElsewhere']>()
    .mockResolvedValue(options.staffElsewhere ?? false);
  const holdsStaffRecord = vi
    .fn<SessionRepository['holdsStaffRecord']>()
    .mockResolvedValue(options.staffHere ?? false);
  const guardianLinkCount = vi
    .fn<SessionRepository['guardianLinkCount']>()
    .mockResolvedValue(options.guardianLinks ?? 0);
  const holdsGuardianRecord = vi
    .fn<SessionRepository['holdsGuardianRecord']>()
    .mockResolvedValue((options.guardianLinks ?? 0) > 0);
  const spendTokens = vi.fn<MfaRepository['spendTokens']>().mockResolvedValue();
  const send = vi.fn<BackgroundMailer['send']>();
  const directory = new AccountDirectory(
    {
      findById,
      findByEmail,
      update,
      insertPending,
      holdsActiveGrant,
      holdsGrantOrRestorable,
      endRoleSessions,
      lockRoleSeparation,
      adminGrantsOfStaff,
      restampRevokeReason,
      revokeGrant,
    } as unknown as AccountRepository,
    {
      endUserSessions,
      hasStaffElsewhere,
      holdsStaffRecord,
      guardianLinkCount,
      holdsGuardianRecord,
    } as unknown as SessionRepository,
    { spendTokens } as unknown as MfaRepository,
    { send } as unknown as BackgroundMailer,
  );
  return {
    directory,
    findById,
    findByEmail,
    update,
    insertPending,
    lockRoleSeparation,
    holdsActiveGrant,
    holdsGrantOrRestorable,
    hasStaffElsewhere,
    holdsStaffRecord,
    guardianLinkCount,
    holdsGuardianRecord,
    adminGrantsOfStaff,
    revokeGrant,
    endRoleSessions,
    endUserSessions,
    spendTokens,
    send,
  };
}

describe('AccountDirectory.changeStaffEmail', () => {
  it('writes nothing for the email the person already has', async () => {
    const t = change();
    const result = await t.directory.changeStaffEmail(tx, request({ email: 'ASHA@example.com' }));
    expect(result).toMatchObject({ kind: 'unchanged', person: { id: 'user-1' } });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.endUserSessions).not.toHaveBeenCalled();
  });

  it('changes the email of a person who holds only this record, and ends every session of theirs', async () => {
    const t = change();
    const result = await t.directory.changeStaffEmail(tx, request());
    expect(result).toMatchObject({
      kind: 'edited',
      previousEmail: 'asha@example.com',
      person: { id: 'user-1', email: 'new@example.com' },
    });
    expect(t.update).toHaveBeenCalledWith(tx, 'user-1', {
      email: 'new@example.com',
      updated_by: 'admin-1',
    });
    expect(t.endUserSessions).toHaveBeenCalledWith(tx, 'user-1', 7, now);
    expect(t.spendTokens).toHaveBeenCalledWith(tx, 'user-1', now);
    expect(t.endRoleSessions).not.toHaveBeenCalled();
  });

  it('moves the record to the person the email belongs to, after vetting them, and ends only the old staff sessions', async () => {
    const t = change({ existing: user({ id: 'user-2', email: 'new@example.com' }) });
    const vet = vi.fn<(personId: string) => Promise<void>>().mockResolvedValue();
    const result = await t.directory.changeStaffEmail(tx, request({ vet }));
    expect(vet).toHaveBeenCalledWith('user-2');
    expect(result).toMatchObject({
      kind: 'moved',
      previousEmail: 'asha@example.com',
      person: { id: 'user-2', created: false },
    });
    expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 4, 'society-1', 4, now);
    expect(t.update).not.toHaveBeenCalled();
    expect(t.endUserSessions).not.toHaveBeenCalled();
  });

  it('passes the refusal of vet on and moves nothing', async () => {
    const t = change({ existing: user({ id: 'user-2' }) });
    const vet = vi.fn<(personId: string) => Promise<void>>().mockRejectedValue(new Error('taken'));
    await expect(t.directory.changeStaffEmail(tx, request({ vet }))).rejects.toThrow('taken');
    expect(t.endRoleSessions).not.toHaveBeenCalled();
  });

  it.each([
    ['blocked', 2, 'ACCOUNT_BLOCKED'],
    ['inactive', 0, 'INVALID_STATE'],
  ])('refuses to move the record to a %s person', async (_name, status, code) => {
    const t = change({ existing: user({ id: 'user-2', account_status: status }) });
    await expect(t.directory.changeStaffEmail(tx, request())).rejects.toMatchObject({
      status: 409,
      code,
    });
  });

  it('refuses to move the record to a Super Admin', async () => {
    const t = change({ existing: user({ id: 'user-2' }) });
    t.holdsActiveGrant.mockResolvedValue(true);
    await expect(t.directory.changeStaffEmail(tx, request())).rejects.toMatchObject({
      status: 409,
      code: 'ROLE_CONFLICT',
    });
  });

  it.each([
    ['holds a grant', { grant: true }],
    ['is staff in another Society too, active or dormant', { staffElsewhere: true }],
  ])(
    'moves the record to a new person when the old one %s, and leaves their account alone',
    async (_name, options) => {
      const t = change(options);
      const result = await t.directory.changeStaffEmail(tx, request());
      expect(t.insertPending).toHaveBeenCalledWith(
        tx,
        { email: 'new@example.com', firstName: 'Asha', lastName: 'Rao' },
        'admin-1',
      );
      expect(result).toMatchObject({ kind: 'moved', person: { id: 'new-1', created: true } });
      expect(t.update).not.toHaveBeenCalled();
      expect(t.endUserSessions).not.toHaveBeenCalled();
      expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 4, 'society-1', 4, now);
    },
  );

  it('takes the Admin grants of the record from the old person when it moves, and ends their Admin sessions', async () => {
    const grants = [
      { id: 'g1', user_id: 'user-1', society_id: 'society-1', institution_id: 'inst-1' },
      { id: 'g2', user_id: 'user-1', society_id: 'society-1', institution_id: 'inst-2' },
    ];
    const t = change({ grant: true, adminGrants: grants });
    const result = await t.directory.changeStaffEmail(tx, request());
    expect(t.adminGrantsOfStaff).toHaveBeenCalledWith(tx, 'staff-1', {
      restorable: ['society_deactivated', 'institution_deactivated'],
    });
    expect(t.revokeGrant.mock.calls.map((call) => call[1])).toEqual(['g1', 'g2']);
    expect(t.revokeGrant).toHaveBeenCalledWith(tx, 'g1', 'admin-1', 'staff_moved', now);
    // Admin sessions (role 3), then staff sessions (role 4), of the old person in this Society.
    expect(t.endRoleSessions.mock.calls.map((call) => call[2])).toEqual([3, 4]);
    expect(result).toMatchObject({
      kind: 'moved',
      adminRevoked: ['inst-1', 'inst-2'],
      sessionsEnded: 2,
    });
  });

  it('counts dormant access as held: grants revoked for a reactivation to restore, and records anywhere', async () => {
    const t = change();
    await t.directory.changeStaffEmail(tx, request());
    expect(t.holdsGrantOrRestorable).toHaveBeenCalledWith(
      tx,
      'user-1',
      [1, 2, 3],
      ['society_deactivated', 'institution_deactivated'],
    );
    expect(t.hasStaffElsewhere).toHaveBeenCalledWith(tx, 'user-1', 'society-1');
  });

  it('takes the identity lock before it reads anyone, so an access cannot land on a person whose email changes at the same time', async () => {
    const t = change();
    await t.directory.changeStaffEmail(tx, request());
    expect(t.lockRoleSeparation).toHaveBeenCalledWith(tx);
    expect(t.findById).toHaveBeenCalledWith(tx, 'user-1', true);
    const lockedAt = t.lockRoleSeparation.mock.invocationCallOrder[0] ?? 0;
    expect(lockedAt).toBeLessThan(t.findById.mock.invocationCallOrder[0] ?? 0);
    expect(lockedAt).toBeLessThan(t.findByEmail.mock.invocationCallOrder[0] ?? 0);
  });

  it('refuses to move the record onto the caller', async () => {
    const t = change({ existing: user({ id: 'admin-1' }) });
    await expect(t.directory.changeStaffEmail(tx, request())).rejects.toMatchObject({
      status: 409,
      code: 'CANNOT_ACT_ON_SELF',
    });
    expect(t.endRoleSessions).not.toHaveBeenCalled();
  });

  it.each([
    ['the email update', 'update'],
    ['the new person', 'insertPending'],
  ] as const)(
    'tells the loser of a race on the email that it is taken, at %s',
    async (_name, step) => {
      const duplicate = Object.assign(new Error('duplicate'), {
        code: '23505',
        constraint: 'uq_users_email',
      });
      const t = change({ grant: step === 'insertPending' });
      t[step].mockRejectedValue(duplicate);
      await expect(t.directory.changeStaffEmail(tx, request())).rejects.toMatchObject({
        status: 409,
        code: 'EMAIL_IN_USE',
      });
    },
  );

  it('answers 404 for a person who is gone', async () => {
    const t = change();
    t.findById.mockResolvedValue(undefined);
    await expect(t.directory.changeStaffEmail(tx, request())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('tells the old and the new address of a changed email, in the school’s name', () => {
    const t = change();
    t.directory.announceStaffEmail(
      {
        kind: 'edited',
        sessionsEnded: 1,
        previousEmail: 'old@example.com',
        person: { id: 'u', email: 'new@example.com', displayName: 'x', created: false },
      },
      'Sunrise',
    );
    expect(t.send.mock.calls.map(([message]) => [message.to, message.template])).toEqual([
      ['old@example.com', 'email-changed-old'],
      ['new@example.com', 'email-changed-new'],
    ]);
  });

  it('tells the old person their access moved, and welcomes the new one', () => {
    const t = change();
    t.directory.announceStaffEmail(
      {
        kind: 'moved',
        sessionsEnded: 1,
        adminRevoked: [],
        previousEmail: 'old@example.com',
        person: { id: 'u', email: 'new@example.com', displayName: 'x', created: true },
      },
      'Sunrise',
    );
    expect(t.send.mock.calls.map(([message]) => [message.to, message.template])).toEqual([
      ['old@example.com', 'staff-access-moved'],
      ['new@example.com', 'welcome'],
    ]);
  });

  it('counts a guardian link as access the person holds, so their own email is not changed from here', async () => {
    const t = change({ guardianLinks: 1 });
    const result = await t.directory.changeStaffEmail(tx, request());
    expect(t.holdsGuardianRecord).toHaveBeenCalledWith(tx, 'user-1');
    expect(result).toMatchObject({ kind: 'moved', person: { id: 'new-1', created: true } });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.endUserSessions).not.toHaveBeenCalled();
  });
});

const guardianRequest = (
  overrides: Partial<Parameters<AccountDirectory['changeGuardianEmail']>[1]> = {},
) => ({
  userId: 'user-1',
  societyId: 'society-1',
  email: 'New@Example.com',
  names: { firstName: 'Ravi', lastName: 'Shetty' },
  by: 'admin-1',
  now,
  vet: vi.fn<(personId: string) => Promise<void>>().mockResolvedValue(),
  ...overrides,
});

describe('AccountDirectory.changeGuardianEmail', () => {
  it('writes nothing for the email the person already has', async () => {
    const t = change();
    const result = await t.directory.changeGuardianEmail(
      tx,
      guardianRequest({ email: 'ASHA@example.com' }),
    );
    expect(result).toMatchObject({ kind: 'unchanged', person: { id: 'user-1' } });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.endUserSessions).not.toHaveBeenCalled();
  });

  it('changes the email of a person who holds only this link, and ends every session of theirs', async () => {
    const t = change({ guardianLinks: 1 });
    const result = await t.directory.changeGuardianEmail(tx, guardianRequest());
    expect(result).toMatchObject({
      kind: 'edited',
      previousEmail: 'asha@example.com',
      person: { id: 'user-1', email: 'new@example.com' },
    });
    expect(t.update).toHaveBeenCalledWith(tx, 'user-1', {
      email: 'new@example.com',
      updated_by: 'admin-1',
    });
    expect(t.endUserSessions).toHaveBeenCalledWith(tx, 'user-1', 7, now);
    expect(t.spendTokens).toHaveBeenCalledWith(tx, 'user-1', now);
    expect(t.endRoleSessions).not.toHaveBeenCalled();
  });

  it.each([
    ['another guardian link', { guardianLinks: 2 }, 0],
    ['a staff record', { guardianLinks: 1, staffHere: true }, 1],
    ['a grant, dormant ones included', { guardianLinks: 1, grant: true }, 1],
  ])(
    'makes a new person and moves the link when the person holds %s, and never edits the account they hold',
    async (_name, options, ended) => {
      const t = change(options);
      const result = await t.directory.changeGuardianEmail(tx, guardianRequest());
      expect(result).toMatchObject({
        kind: 'moved',
        previousEmail: 'asha@example.com',
        person: { id: 'new-1', created: true },
        sessionsEnded: ended,
      });
      expect(t.insertPending).toHaveBeenCalledWith(
        tx,
        { email: 'new@example.com', firstName: 'Ravi', lastName: 'Shetty' },
        'admin-1',
      );
      expect(t.update).not.toHaveBeenCalled();
      expect(t.endUserSessions).not.toHaveBeenCalled();
    },
  );

  it.each([
    [1, 1],
    [2, 0],
  ])(
    'ends the parent sessions of the old person only when this was their last link: %s link(s) held, %s session(s) ended',
    async (links, ended) => {
      const t = change({
        existing: user({ id: 'user-2', email: 'new@example.com' }),
        guardianLinks: links,
      });
      const result = await t.directory.changeGuardianEmail(tx, guardianRequest());
      expect(result).toMatchObject({ kind: 'moved', sessionsEnded: ended });
      expect(t.endRoleSessions).toHaveBeenCalledTimes(ended);
    },
  );

  it('counts dormant access as held: grants a reactivation restores, a staff record and links anywhere', async () => {
    const t = change({ guardianLinks: 1 });
    await t.directory.changeGuardianEmail(tx, guardianRequest());
    expect(t.holdsGrantOrRestorable).toHaveBeenCalledWith(
      tx,
      'user-1',
      [1, 2, 3],
      ['society_deactivated', 'institution_deactivated'],
    );
    expect(t.holdsStaffRecord).toHaveBeenCalledWith(tx, 'user-1');
    expect(t.guardianLinkCount).toHaveBeenCalledWith(tx, 'user-1');
  });

  it('moves the link to the person the email belongs to, after vetting them as a parent', async () => {
    const t = change({ existing: user({ id: 'user-2', email: 'new@example.com' }) });
    const vet = vi.fn<(personId: string) => Promise<void>>().mockResolvedValue();
    const result = await t.directory.changeGuardianEmail(tx, guardianRequest({ vet }));
    expect(vet).toHaveBeenCalledWith('user-2');
    expect(result).toMatchObject({ kind: 'moved', person: { id: 'user-2', created: false } });
    expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 5, null, 4, now);
    expect(t.update).not.toHaveBeenCalled();
  });

  it('passes the refusal of vet on and moves nothing', async () => {
    const t = change({ existing: user({ id: 'user-2' }) });
    const vet = vi.fn<(personId: string) => Promise<void>>().mockRejectedValue(new Error('taken'));
    await expect(t.directory.changeGuardianEmail(tx, guardianRequest({ vet }))).rejects.toThrow(
      'taken',
    );
    expect(t.endRoleSessions).not.toHaveBeenCalled();
  });

  it.each([
    ['blocked', 2, 'ACCOUNT_BLOCKED'],
    ['inactive', 0, 'INVALID_STATE'],
  ])('refuses to move the link to a %s person', async (_name, status, code) => {
    const t = change({ existing: user({ id: 'user-2', account_status: status }) });
    await expect(t.directory.changeGuardianEmail(tx, guardianRequest())).rejects.toMatchObject({
      status: 409,
      code,
    });
  });

  it('refuses to move the link to a Super Admin', async () => {
    const t = change({ existing: user({ id: 'user-2' }) });
    t.holdsActiveGrant.mockResolvedValue(true);
    await expect(t.directory.changeGuardianEmail(tx, guardianRequest())).rejects.toMatchObject({
      status: 409,
      code: 'ROLE_CONFLICT',
    });
  });

  it('takes the identity lock before it reads anyone', async () => {
    const t = change();
    await t.directory.changeGuardianEmail(tx, guardianRequest());
    const lockedAt = t.lockRoleSeparation.mock.invocationCallOrder[0] ?? 0;
    expect(t.findById).toHaveBeenCalledWith(tx, 'user-1', true);
    expect(lockedAt).toBeLessThan(t.findById.mock.invocationCallOrder[0] ?? 0);
    expect(lockedAt).toBeLessThan(t.findByEmail.mock.invocationCallOrder[0] ?? 0);
  });

  it('tells the loser of a race on the email that it is taken, and answers 404 for a person who is gone', async () => {
    const duplicate = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint: 'uq_users_email',
    });
    const raced = change({ guardianLinks: 1 });
    raced.update.mockRejectedValue(duplicate);
    await expect(raced.directory.changeGuardianEmail(tx, guardianRequest())).rejects.toMatchObject({
      status: 409,
      code: 'EMAIL_IN_USE',
    });
    const gone = change();
    gone.findById.mockResolvedValue(undefined);
    await expect(gone.directory.changeGuardianEmail(tx, guardianRequest())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('tells the old and the new address of a changed email, in the child’s school’s name', () => {
    const t = change();
    t.directory.announceGuardianEmail(
      {
        kind: 'edited',
        sessionsEnded: 1,
        previousEmail: 'old@example.com',
        person: { id: 'u', email: 'new@example.com', displayName: 'x', created: false },
      },
      'Sunrise',
    );
    expect(t.send.mock.calls.map(([message]) => [message.to, message.template])).toEqual([
      ['old@example.com', 'email-changed-old'],
      ['new@example.com', 'email-changed-new'],
    ]);
  });

  it('tells the old person their access moved, and welcomes the new one as a parent', () => {
    const t = change();
    t.directory.announceGuardianEmail(
      {
        kind: 'moved',
        sessionsEnded: 1,
        previousEmail: 'old@example.com',
        person: { id: 'u', email: 'new@example.com', displayName: 'x', created: true },
      },
      'Sunrise',
    );
    expect(t.send.mock.calls.map(([message]) => [message.to, message.template])).toEqual([
      ['old@example.com', 'guardian-access-moved'],
      ['new@example.com', 'welcome'],
    ]);
    expect(t.send.mock.calls[1]![0].variables).toMatchObject({ role: 'Parent' });
  });

  it('tells a guardian who lost the link that they did', () => {
    const t = change();
    t.directory.announceGuardianRemoved('old@example.com');
    expect(t.send.mock.calls.map(([message]) => [message.to, message.template])).toEqual([
      ['old@example.com', 'guardian-access-removed'],
    ]);
  });
});

describe('AccountDirectory.endParentSessionsIfLast', () => {
  it('ends the parent sessions of a person whose last link this is, which name no Society', async () => {
    const t = change({ guardianLinks: 1 });
    expect(await t.directory.endParentSessionsIfLast(tx, 'user-1', now)).toBe(1);
    expect(t.guardianLinkCount).toHaveBeenCalledWith(tx, 'user-1');
    expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 5, null, 4, now);
  });

  it('leaves them while the person holds another link, which counts this one too', async () => {
    const t = change({ guardianLinks: 2 });
    expect(await t.directory.endParentSessionsIfLast(tx, 'user-1', now)).toBe(0);
    expect(t.endRoleSessions).not.toHaveBeenCalled();
  });
});

describe('AccountDirectory.changeOwnEmail', () => {
  it('changes the email, ends every session and open step, and says how many sessions ended', async () => {
    const t = change();
    const changed = await t.directory.changeOwnEmail(
      tx,
      'user-1',
      'new@example.com',
      'admin-1',
      now,
    );
    expect(changed).toMatchObject({ sessionsEnded: 3, person: { email: 'new@example.com' } });
    expect(t.update).toHaveBeenCalledWith(tx, 'user-1', {
      email: 'new@example.com',
      updated_by: 'admin-1',
    });
    expect(t.endUserSessions).toHaveBeenCalledWith(tx, 'user-1', 7, now);
    expect(t.spendTokens).toHaveBeenCalledWith(tx, 'user-1', now);
  });

  it('tells the old and the new address, naming the changer when there is one', () => {
    const t = change();
    t.directory.announceEmailChange('old@example.com', 'new@example.com');
    t.directory.announceEmailChange('old@example.com', 'new@example.com', 'your school');
    const texts = t.send.mock.calls.map(([message]) => message.text);
    expect(texts[0]).toContain('a platform administrator');
    expect(texts[2]).toContain('your school');
    expect(t.send.mock.calls.map(([message]) => message.to)).toEqual([
      'old@example.com',
      'new@example.com',
      'old@example.com',
      'new@example.com',
    ]);
  });
});

const grantRequest = {
  userId: 'user-1',
  societyId: 'society-1',
  institutionId: 'inst-1',
  staffMemberId: 'staff-1',
  by: 'owner-1',
  now,
};

function admin(
  person: AccountRow | null = user(),
  grants: {
    id: string;
    user_id: string;
    society_id: string;
    institution_id: string;
    revoked_at?: Date | null;
  }[] = [],
) {
  const findById = vi.fn<AccountRepository['findById']>().mockResolvedValue(person ?? undefined);
  const insertAdminGrant = vi
    .fn<AccountRepository['insertAdminGrant']>()
    .mockResolvedValue({} as never);
  const adminGrantsOfStaff = vi
    .fn<AccountRepository['adminGrantsOfStaff']>()
    .mockResolvedValue(grants.map((grant) => ({ revoked_at: null, ...grant })) as never);
  const revokeGrant = vi.fn<AccountRepository['revokeGrant']>().mockResolvedValue();
  const restampRevokeReason = vi.fn<AccountRepository['restampRevokeReason']>().mockResolvedValue();
  const holdsActiveGrant = vi.fn<AccountRepository['holdsActiveGrant']>().mockResolvedValue(false);
  const lockRoleSeparation = vi.fn<AccountRepository['lockRoleSeparation']>().mockResolvedValue();
  const endRoleSessions = vi.fn<AccountRepository['endRoleSessions']>().mockResolvedValue(2);
  const send = vi.fn<BackgroundMailer['send']>();
  const directory = new AccountDirectory(
    {
      findById,
      insertAdminGrant,
      adminGrantsOfStaff,
      revokeGrant,
      restampRevokeReason,
      holdsActiveGrant,
      lockRoleSeparation,
      endRoleSessions,
    } as unknown as AccountRepository,
    {} as SessionRepository,
    {} as MfaRepository,
    { send } as unknown as BackgroundMailer,
  );
  return {
    directory,
    findById,
    insertAdminGrant,
    adminGrantsOfStaff,
    revokeGrant,
    restampRevokeReason,
    holdsActiveGrant,
    lockRoleSeparation,
    endRoleSessions,
    send,
  };
}

const held = { id: 'g1', user_id: 'user-1', society_id: 'society-1', institution_id: 'inst-1' };

describe('AccountDirectory, Institution Admin access', () => {
  describe('grantInstitutionAdmin', () => {
    it('locks the person, writes the grant tied to the record and returns who holds it', async () => {
      const t = admin();
      const person = await t.directory.grantInstitutionAdmin(tx, grantRequest);
      expect(t.findById).toHaveBeenCalledWith(tx, 'user-1', true);
      expect(t.insertAdminGrant).toHaveBeenCalledWith(tx, grantRequest);
      expect(person).toEqual({ id: 'user-1', email: 'asha@example.com', displayName: 'Asha' });
    });

    it.each([
      [2, 'ACCOUNT_BLOCKED'],
      [0, 'INVALID_STATE'],
    ])(
      'refuses a person whose account status is %s with 409 %s, writing nothing',
      async (status, code) => {
        const t = admin(user({ account_status: status }));
        await expect(t.directory.grantInstitutionAdmin(tx, grantRequest)).rejects.toMatchObject({
          status: 409,
          code,
        });
        expect(t.insertAdminGrant).not.toHaveBeenCalled();
      },
    );

    it('turns the unique index on the active grant into 409 ALREADY_ADMIN and lets other failures through', async () => {
      const t = admin();
      t.insertAdminGrant.mockRejectedValue(
        Object.assign(new Error('duplicate'), {
          code: '23505',
          constraint: 'uq_role_assignments_active_grant',
        }),
      );
      await expect(t.directory.grantInstitutionAdmin(tx, grantRequest)).rejects.toMatchObject({
        status: 409,
        code: 'ALREADY_ADMIN',
      });
      t.insertAdminGrant.mockRejectedValue(new Error('boom'));
      await expect(t.directory.grantInstitutionAdmin(tx, grantRequest)).rejects.toThrow('boom');
    });

    it('takes the identity lock before it locks the person row, as every other change does, so the two cannot deadlock', async () => {
      const t = admin();
      await t.directory.grantInstitutionAdmin(tx, grantRequest);
      expect(t.lockRoleSeparation).toHaveBeenCalledWith(tx);
      expect(t.lockRoleSeparation.mock.invocationCallOrder[0]).toBeLessThan(
        t.findById.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('refuses a Super Admin with 409 ROLE_CONFLICT, before it locks the person', async () => {
      const t = admin();
      t.holdsActiveGrant.mockResolvedValue(true);
      await expect(t.directory.grantInstitutionAdmin(tx, grantRequest)).rejects.toMatchObject({
        status: 409,
        code: 'ROLE_CONFLICT',
      });
      expect(t.holdsActiveGrant).toHaveBeenCalledWith(tx, 'user-1', [1]);
      expect(t.insertAdminGrant).not.toHaveBeenCalled();
      expect(t.findById).not.toHaveBeenCalled();
    });

    it('is 404 for a person who is gone', async () => {
      const t = admin(null);
      await expect(t.directory.grantInstitutionAdmin(tx, grantRequest)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('revokeInstitutionAdmin', () => {
    it('revokes the grant of the record for the Institution and ends the Admin sessions in the Society', async () => {
      const t = admin(user(), [held]);
      const result = await t.directory.revokeInstitutionAdmin(
        tx,
        'staff-1',
        'inst-1',
        'owner-1',
        'revoked_by_owner',
        now,
      );
      expect(t.adminGrantsOfStaff).toHaveBeenCalledWith(tx, 'staff-1', { institutionId: 'inst-1' });
      expect(t.revokeGrant).toHaveBeenCalledWith(tx, 'g1', 'owner-1', 'revoked_by_owner', now);
      expect(t.endRoleSessions).toHaveBeenCalledWith(tx, 'user-1', 3, 'society-1', 4, now);
      expect(result).toEqual({
        id: 'user-1',
        email: 'asha@example.com',
        displayName: 'Asha',
        sessionsEnded: 2,
      });
    });

    it('is 404 when the record holds no active grant for the Institution', async () => {
      const t = admin();
      await expect(
        t.directory.revokeInstitutionAdmin(
          tx,
          'staff-1',
          'inst-1',
          'owner-1',
          'revoked_by_owner',
          now,
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(t.revokeGrant).not.toHaveBeenCalled();
      expect(t.endRoleSessions).not.toHaveBeenCalled();
    });
  });

  describe('revokeAdminAccessOfStaff', () => {
    it('revokes every grant of the record with the reason, and ends the Admin sessions once', async () => {
      const t = admin(user(), [held, { ...held, id: 'g2', institution_id: 'inst-2' }]);
      const result = await t.directory.revokeAdminAccessOfStaff(
        tx,
        'staff-1',
        'owner-1',
        'staff_deactivated',
        now,
      );
      expect(t.revokeGrant.mock.calls.map((call) => [call[1], call[3]])).toEqual([
        ['g1', 'staff_deactivated'],
        ['g2', 'staff_deactivated'],
      ]);
      expect(t.endRoleSessions).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ institutionIds: ['inst-1', 'inst-2'], sessionsEnded: 2 });
    });

    it('gives a grant that went dormant with its Institution the new reason, keeping when it was revoked', async () => {
      const dormant = {
        ...held,
        id: 'g2',
        institution_id: 'inst-2',
        revoked_at: new Date('2026-10-01T00:00:00Z'),
      };
      const t = admin(user(), [held, dormant]);
      const result = await t.directory.revokeAdminAccessOfStaff(
        tx,
        'staff-1',
        'owner-1',
        'staff_moved',
        now,
      );
      expect(t.adminGrantsOfStaff).toHaveBeenCalledWith(tx, 'staff-1', {
        restorable: ['society_deactivated', 'institution_deactivated'],
      });
      expect(t.revokeGrant.mock.calls.map((call) => call[1])).toEqual(['g1']);
      expect(t.restampRevokeReason).toHaveBeenCalledWith(tx, ['g2'], 'staff_moved');
      expect(result).toEqual({ institutionIds: ['inst-1', 'inst-2'], sessionsEnded: 2 });
    });

    it('ends no session for a record that holds only dormant grants', async () => {
      const t = admin(user(), [{ ...held, revoked_at: new Date('2026-10-01T00:00:00Z') }]);
      const result = await t.directory.revokeAdminAccessOfStaff(
        tx,
        'staff-1',
        'owner-1',
        'staff_deactivated',
        now,
      );
      expect(t.revokeGrant).not.toHaveBeenCalled();
      expect(t.endRoleSessions).not.toHaveBeenCalled();
      expect(result).toEqual({ institutionIds: ['inst-1'], sessionsEnded: 0 });
    });

    it('does nothing for a record with no grant', async () => {
      const t = admin();
      expect(
        await t.directory.revokeAdminAccessOfStaff(
          tx,
          'staff-1',
          'owner-1',
          'staff_deactivated',
          now,
        ),
      ).toEqual({
        institutionIds: [],
        sessionsEnded: 0,
      });
      expect(t.revokeGrant).not.toHaveBeenCalled();
      expect(t.endRoleSessions).not.toHaveBeenCalled();
    });
  });

  describe('adminAccessOfStaff', () => {
    it('tells the Institutions of active grants from those of grants that went dormant with theirs', async () => {
      const t = admin(user(), [
        held,
        { ...held, id: 'g2', institution_id: 'inst-2', revoked_at: new Date('2026-10-01') },
      ]);
      expect(await t.directory.adminAccessOfStaff(tx, 'staff-1')).toEqual({
        active: ['inst-1'],
        dormant: ['inst-2'],
      });
      expect(t.adminGrantsOfStaff).toHaveBeenCalledWith(tx, 'staff-1', {
        restorable: ['society_deactivated', 'institution_deactivated'],
      });
    });
  });

  describe('releaseDormantAdminAccess', () => {
    it('gives the dormant grants at the named Institutions the new reason, and leaves active ones and others alone', async () => {
      const dormant = { ...held, revoked_at: new Date('2026-10-01') };
      const t = admin(user(), [
        held,
        { ...dormant, id: 'g2', institution_id: 'inst-2' },
        { ...dormant, id: 'g3', institution_id: 'inst-3' },
      ]);
      const released = await t.directory.releaseDormantAdminAccess(
        tx,
        'staff-1',
        ['inst-1', 'inst-2'],
        'staff_institution_removed',
      );
      expect(released).toEqual(['inst-2']);
      expect(t.restampRevokeReason).toHaveBeenCalledWith(tx, ['g2'], 'staff_institution_removed');
      expect(t.revokeGrant).not.toHaveBeenCalled();
    });
  });

  it('tells the person after the commit, naming the Institution', () => {
    const t = admin();
    t.directory.announceAdminAccess({ email: 'asha@example.com' }, 'granted', 'Green Valley');
    t.directory.announceAdminAccess({ email: 'asha@example.com' }, 'revoked', 'Green Valley');
    expect(t.send.mock.calls.map(([message]) => [message.to, message.template])).toEqual([
      ['asha@example.com', 'admin-access-granted'],
      ['asha@example.com', 'admin-access-revoked'],
    ]);
    expect(t.send.mock.calls[0]![0].text).toContain('Green Valley');
  });
});
