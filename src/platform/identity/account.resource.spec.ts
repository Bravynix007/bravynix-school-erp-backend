import type { AccountRow } from './account.repository.js';
import { accountResource, superAdminResource } from './account.resource.js';

const user = (overrides: Partial<AccountRow> = {}): AccountRow =>
  ({
    id: 'u1',
    email: 'asha@example.com',
    first_name: 'Asha',
    last_name: 'Rao',
    account_status: 3,
    blocked_at: null,
    block_reason: null,
    version: 4,
    ...overrides,
  }) as AccountRow;

describe('accountResource', () => {
  it('shows a Pending account as Active and every field, empty ones as null', () => {
    expect(accountResource(user())).toEqual({
      id: 'u1',
      email: 'asha@example.com',
      displayName: 'Asha Rao',
      accountStatus: 1,
      blockedAt: null,
      blockReason: null,
      version: 4,
    });
  });

  it('falls back to the email for a person with no name, and shows a block', () => {
    const blocked = accountResource(
      user({
        first_name: null,
        last_name: null,
        account_status: 2,
        blocked_at: new Date('2026-10-26T10:00:00.000Z'),
        block_reason: 'Left the school',
      }),
    );
    expect(blocked).toMatchObject({
      displayName: 'asha@example.com',
      accountStatus: 2,
      blockedAt: '2026-10-26T10:00:00.000Z',
      blockReason: 'Left the school',
    });
  });
});

describe('superAdminResource', () => {
  it('adds the seat, the authenticator and when the seat was given', () => {
    const resource = superAdminResource(
      { user: user(), seatNo: 2, grantedAt: new Date('2026-10-01T00:00:00.000Z') },
      true,
    );
    expect(resource).toMatchObject({
      id: 'u1',
      seatNo: 2,
      authenticatorSetUp: true,
      grantedAt: '2026-10-01T00:00:00.000Z',
    });
  });
});
