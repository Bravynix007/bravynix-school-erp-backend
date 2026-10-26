import type { Principal } from '../../common/auth/access-token-verifier.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../audit/index.js';
import type { DatabaseService, Tx } from '../database/index.js';
import type {
  AccountDirectory,
  GrantDirectory,
  GrantedPerson,
  OwnerGrant,
} from '../identity/index.js';
import { SocietyOwnerService } from './society-owner.service.js';
import type { SocietyRepository, SocietyRow } from './society.repository.js';

const principal = { personId: 'admin-1', roleCode: 1, societyId: null } as unknown as Principal;
const tx = {} as Tx;
const society = (overrides: Partial<SocietyRow> = {}) =>
  ({ id: 'society-1', name: 'Sunrise', status: 1, version: 1, ...overrides }) as SocietyRow;
const granted: GrantedPerson = {
  id: 'owner-1',
  email: 'asha@example.com',
  displayName: 'Asha',
  seatNo: 2,
  created: true,
};

function build(found: SocietyRow | null = society()) {
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<SocietyRepository['find']>().mockResolvedValue(found ?? undefined);
  const refs = vi
    .fn<SocietyRepository['refs']>()
    .mockResolvedValue(new Map([['society-1', { id: 'society-1', code: 'SUN', name: 'Sunrise' }]]));
  const grant = vi.fn<AccountDirectory['grant']>().mockResolvedValue(granted);
  const revoke = vi.fn<AccountDirectory['revoke']>().mockResolvedValue(2);
  const welcome = vi.fn<AccountDirectory['welcome']>();
  const ownersPage = vi.fn<GrantDirectory['ownersPage']>();
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new SocietyOwnerService(
    { transaction } as unknown as DatabaseService,
    { find, refs } as unknown as SocietyRepository,
    { grant, revoke, welcome } as unknown as AccountDirectory,
    { ownersPage } as unknown as GrantDirectory,
    { record } as unknown as AuditService,
    new FixedClock('2026-10-26T10:00:00.000Z'),
  );
  return { service, transaction, grant, revoke, welcome, ownersPage, refs, record };
}

describe('add (PLT-09)', () => {
  it('adds the Owner in the Society’s own context, audits it there, then welcomes them', async () => {
    const t = build();
    await expect(
      t.service.add(principal, 'society-1', { email: 'asha@example.com' }),
    ).resolves.toEqual({
      id: 'owner-1',
      email: 'asha@example.com',
      displayName: 'Asha',
      societyId: 'society-1',
      seatNo: 2,
    });
    expect(t.transaction.mock.calls[0]![0]).toMatchObject({ societyId: 'society-1' });
    expect(t.grant).toHaveBeenCalledWith(
      tx,
      { roleCode: 2, societyId: 'society-1' },
      { email: 'asha@example.com' },
      'admin-1',
      expect.any(Date),
    );
    expect(t.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'owner.add',
        societyId: 'society-1',
        after: { email: 'a***@example.com', seat_no: 2 },
      }),
    );
    expect(t.welcome).toHaveBeenCalledWith(
      granted,
      { roleCode: 2, societyId: 'society-1' },
      'Sunrise',
    );
  });

  it('answers 404 for an unknown Society and 409 for a deactivated one, adding nobody', async () => {
    const unknown = build(null);
    await expect(
      unknown.service.add(principal, 'society-1', { email: 'a@example.com' }),
    ).rejects.toMatchObject({ status: 404 });
    const gone = build(society({ status: 0 }));
    await expect(
      gone.service.add(principal, 'society-1', { email: 'a@example.com' }),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(gone.grant).not.toHaveBeenCalled();
    expect(gone.welcome).not.toHaveBeenCalled();
  });
});

describe('remove (PLT-10)', () => {
  it('revokes the Owner’s grant and audits the sessions it ended', async () => {
    const t = build();
    await expect(t.service.remove(principal, 'society-1', 'owner-1')).resolves.toEqual({
      id: 'owner-1',
      status: 0,
    });
    expect(t.revoke).toHaveBeenCalledWith(
      tx,
      { roleCode: 2, societyId: 'society-1' },
      'owner-1',
      'admin-1',
      'owner_removed',
      expect.any(Date),
    );
    expect(t.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'owner.remove',
        societyId: 'society-1',
        after: { sessions_ended: 2 },
      }),
    );
  });

  it('answers 404 for an unknown Society', async () => {
    const t = build(null);
    await expect(t.service.remove(principal, 'society-1', 'owner-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(t.revoke).not.toHaveBeenCalled();
  });
});

describe('list (PLT-11)', () => {
  const grant: OwnerGrant = {
    id: 'owner-1',
    email: 'asha@example.com',
    displayName: 'Asha',
    accountStatus: 1,
    societyId: 'society-1',
    seatNo: 1,
    grantedAt: new Date('2026-10-01T00:00:00.000Z'),
  };

  it('names each Owner’s Society and pages the answer, sorted by name by default', async () => {
    const t = build();
    t.ownersPage.mockResolvedValue({ rows: [grant, { ...grant, id: 'owner-2' }], total: 41 });
    const result = await t.service.list(principal, { page: 2, limit: 20, q: 'asha' });
    expect(t.ownersPage).toHaveBeenCalledWith(
      { q: 'asha', societyId: undefined },
      [{ field: 'name', direction: 'asc' }],
      20,
      20,
    );
    expect(t.refs).toHaveBeenCalledWith(tx, ['society-1']);
    expect(result.options.meta).toEqual({ page: 2, limit: 20, totalItems: 41, totalPages: 3 });
    expect(result.data[0]).toMatchObject({
      id: 'owner-1',
      grantedAt: '2026-10-01T00:00:00.000Z',
      society: { id: 'society-1', code: 'SUN', name: 'Sunrise' },
    });
  });

  it('rejects a sort field it does not offer', async () => {
    const t = build();
    await expect(
      t.service.list(principal, { page: 1, limit: 20, sort: 'seat' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_SORT',
    });
  });
});
