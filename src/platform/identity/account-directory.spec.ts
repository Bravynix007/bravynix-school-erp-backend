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
      findByEmail,
      insertPending,
      activeGrant,
      takenSeats,
      insertGrant,
      revokeGrant,
      endRoleSessions,
    } as unknown as AccountRepository,
    {} as SessionRepository,
    {} as MfaRepository,
    { send } as unknown as BackgroundMailer,
  );
  return {
    directory,
    lockSeats,
    lockRoleSeparation,
    holdsActiveGrant,
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

const request = (overrides: Partial<Parameters<AccountDirectory['changeStaffEmail']>[1]> = {}) => ({
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
  options: { existing?: AccountRow; grant?: boolean; staffElsewhere?: boolean } = {},
) {
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
    } as unknown as AccountRepository,
    { endUserSessions, hasStaffElsewhere } as unknown as SessionRepository,
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
