import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { ScopeService } from '../../platform/tenancy/index.js';
import { StaffContext } from './staff-context.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

const principal = (roleCode: number, personId = 'person-1') =>
  ({ personId, roleCode, societyId: 'society-1' }) as unknown as Principal;
const record = (overrides: Partial<StaffRow> = {}) =>
  ({
    id: 'staff-1',
    user_id: 'user-1',
    home_institution_id: 'institution-1',
    ...overrides,
  }) as StaffRow;

function build(found?: StaffRow) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<StaffRepository['find']>().mockResolvedValue(found);
  const context = { institutionId: 'institution-1' } as Awaited<
    ReturnType<ScopeService['requireInstitution']>
  >;
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant: { societyId: 'society-1' } } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  return {
    context: new StaffContext(
      { transaction } as unknown as DatabaseService,
      { find } as unknown as StaffRepository,
      { requireInstitution, forPrincipal } as unknown as ScopeService,
    ),
    find,
    requireInstitution,
    result: context,
  };
}

describe('StaffContext', () => {
  it('is the Institution context of the record’s home, which the caller must reach', async () => {
    const t = build(record());
    const owner = principal(2);
    expect(await t.context.of(owner, 'staff-1')).toBe(t.result);
    expect(t.find).toHaveBeenCalledWith(expect.anything(), 'staff-1');
    expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
  });

  it('is 404 for a record that is not there, without asking about the Institution', async () => {
    const t = build();
    await expect(t.context.of(principal(2), 'staff-1')).rejects.toMatchObject({ status: 404 });
    expect(t.requireInstitution).not.toHaveBeenCalled();
  });

  it('lets a teacher reach their own record and nobody else’s', async () => {
    const own = build(record());
    expect(await own.context.of(principal(4, 'user-1'), 'staff-1')).toBe(own.result);
    const other = build(record());
    await expect(other.context.of(principal(4, 'user-2'), 'staff-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(other.requireInstitution).not.toHaveBeenCalled();
  });

  it('passes on a refusal of the Institution check', async () => {
    const t = build(record());
    t.requireInstitution.mockRejectedValue(Object.assign(new Error('x'), { status: 423 }));
    await expect(t.context.of(principal(3), 'staff-1')).rejects.toMatchObject({ status: 423 });
  });

  describe('lockedActive', () => {
    const tx = {} as Tx;

    it('gives the record, read with the lock', async () => {
      const found = record({ status: 1 });
      const t = build(found);
      expect(await t.context.lockedActive(tx, 'staff-1')).toBe(found);
      expect(t.find).toHaveBeenCalledWith(tx, 'staff-1', true);
    });

    it('is 404 for a record that is gone or deactivated', async () => {
      await expect(build().context.lockedActive(tx, 'staff-1')).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        build(record({ status: 0 })).context.lockedActive(tx, 'staff-1'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
