import type { Tx } from '../database/index.js';
import { AccountDirectory, type SeatKind } from './account-directory.js';
import type { AccountRow, AccountRepository } from './account.repository.js';
import type { BackgroundMailer } from './background-mailer.js';

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
  const lockPerson = vi.fn<AccountRepository['lockPerson']>().mockResolvedValue();
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
      lockPerson,
      holdsActiveGrant,
      findByEmail,
      insertPending,
      activeGrant,
      takenSeats,
      insertGrant,
      revokeGrant,
      endRoleSessions,
    } as unknown as AccountRepository,
    { send } as unknown as BackgroundMailer,
  );
  return {
    directory,
    lockSeats,
    lockPerson,
    holdsActiveGrant,
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

  it('checks the other role under the person lock, after the seat lock', async () => {
    const t = build(user());
    await t.directory.grant(tx, owner, { email: 'asha@example.com' }, 'admin-1', now);
    expect(t.lockPerson).toHaveBeenCalledWith(tx, 'user-1');
    expect(t.lockSeats.mock.invocationCallOrder[0]).toBeLessThan(
      t.lockPerson.mock.invocationCallOrder[0] ?? 0,
    );
    expect(t.lockPerson.mock.invocationCallOrder[0]).toBeLessThan(
      t.holdsActiveGrant.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('takes no person lock for a new email, who holds nothing yet', async () => {
    const t = build(undefined);
    await t.directory.grant(tx, owner, { email: 'new@example.com' }, 'admin-1', now);
    expect(t.lockPerson).not.toHaveBeenCalled();
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
