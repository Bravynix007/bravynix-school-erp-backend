import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { AccountDirectory, GrantDirectory } from '../../platform/identity/index.js';
import type { InstitutionDirectory, ScopeService } from '../../platform/tenancy/index.js';
import type { ListAdminsQueryDto } from './institution-admin.dto.js';
import { InstitutionAdminService } from './institution-admin.service.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

const owner = { personId: 'owner-1', roleCode: 2, societyId: 'society-1' } as unknown as Principal;
const now = new Date('2026-11-08T04:30:00.000Z');
const holder = { id: 'user-1', email: 'meera@example.com', displayName: 'Meera' };

const staff = (overrides: Partial<StaffRow> = {}): StaffRow =>
  ({
    id: 'staff-1',
    society_id: 'society-1',
    home_institution_id: 'institution-1',
    user_id: 'user-1',
    status: 1,
    access_blocked_at: null,
    ...overrides,
  }) as StaffRow;

function build(current: StaffRow | null = staff()) {
  const tx = {} as Tx;
  const order: string[] = [];
  const transaction = vi.fn<DatabaseService['transaction']>(async (_tenant, work) => {
    const result = await work(tx);
    order.push('commit');
    return result;
  });
  const find = vi.fn<StaffRepository['find']>().mockResolvedValue(current ?? undefined);
  const institutionIds = vi.fn<StaffRepository['institutionIds']>().mockResolvedValue([]);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue({
    institutionId: 'institution-1',
    societyId: 'society-1',
    tenant: { societyId: 'society-1', institutionIds: ['institution-1'] },
  });
  const grantInstitutionAdmin = vi
    .fn<AccountDirectory['grantInstitutionAdmin']>()
    .mockResolvedValue(holder);
  const revokeInstitutionAdmin = vi
    .fn<AccountDirectory['revokeInstitutionAdmin']>()
    .mockResolvedValue({ ...holder, sessionsEnded: 2 });
  const announceAdminAccess = vi.fn<AccountDirectory['announceAdminAccess']>(() => {
    order.push('announce');
  });
  const institutionAdmins = vi.fn<GrantDirectory['institutionAdmins']>().mockResolvedValue({
    rows: [
      { staffMemberId: 'staff-1', grantedAt: now, person: { id: 'user-1', displayName: 'Meera' } },
    ],
    total: 41,
  });
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new InstitutionAdminService(
    { transaction } as unknown as DatabaseService,
    { find, institutionIds } as unknown as StaffRepository,
    { requireInstitution } as unknown as ScopeService,
    {
      grantInstitutionAdmin,
      revokeInstitutionAdmin,
      announceAdminAccess,
    } as unknown as AccountDirectory,
    { institutionAdmins } as unknown as GrantDirectory,
    {
      names: vi.fn<InstitutionDirectory['names']>().mockResolvedValue(
        new Map([
          [
            'institution-1',
            {
              id: 'institution-1',
              name: 'Green Valley',
              societyId: 'society-1',
              societyName: 'Sunrise',
            },
          ],
        ]),
      ),
    } as unknown as InstitutionDirectory,
    { record } as unknown as AuditService,
    new FixedClock(now.toISOString()),
  );
  return {
    service,
    order,
    find,
    institutionIds,
    requireInstitution,
    grantInstitutionAdmin,
    revokeInstitutionAdmin,
    announceAdminAccess,
    institutionAdmins,
    record,
  };
}

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('InstitutionAdminService', () => {
  describe('list (INS-08)', () => {
    it('checks the Institution is the caller’s first, then reads one page, with the page meta', async () => {
      const t = build();
      const result = await t.service.list(owner, 'institution-1', {
        page: 3,
        limit: 10,
      } as ListAdminsQueryDto);
      expect(t.requireInstitution).toHaveBeenCalledWith(owner, 'institution-1');
      expect(t.institutionAdmins).toHaveBeenCalledWith('institution-1', 10, 20);
      expect(result.options.meta).toEqual({ page: 3, limit: 10, totalItems: 41, totalPages: 5 });
      expect(result.data).toEqual([
        {
          institutionId: 'institution-1',
          staffMemberId: 'staff-1',
          person: { id: 'user-1', displayName: 'Meera' },
          grantedAt: now.toISOString(),
        },
      ]);
    });

    it('passes on a refusal of the scope check without reading', async () => {
      const t = build();
      t.requireInstitution.mockRejectedValue(AppException.notFound());
      expect(
        await fail(t.service.list(owner, 'x', { page: 1, limit: 20 } as ListAdminsQueryDto)),
      ).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(t.institutionAdmins).not.toHaveBeenCalled();
    });
  });

  describe('grant (INS-09)', () => {
    it('locks the record, grants, audits, and tells the person after the commit', async () => {
      const t = build();
      const result = await t.service.grant(owner, 'institution-1', { staffMemberId: 'staff-1' });
      expect(t.find).toHaveBeenCalledWith(expect.anything(), 'staff-1', true);
      expect(t.grantInstitutionAdmin).toHaveBeenCalledWith(expect.anything(), {
        userId: 'user-1',
        societyId: 'society-1',
        institutionId: 'institution-1',
        staffMemberId: 'staff-1',
        by: 'owner-1',
        now,
      });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'access.grant',
        institutionId: 'institution-1',
        entityType: 'staff_member',
        entityId: 'staff-1',
        after: { roleCode: 3, institutionId: 'institution-1', personId: 'user-1' },
      });
      expect(t.announceAdminAccess).toHaveBeenCalledWith(holder, 'granted', 'Green Valley');
      expect(t.order).toEqual(['commit', 'announce']);
      expect(result).toEqual({
        institutionId: 'institution-1',
        staffMemberId: 'staff-1',
        person: { id: 'user-1', displayName: 'Meera' },
        grantedAt: now.toISOString(),
      });
    });

    it('accepts a record whose extra Institution this is', async () => {
      const t = build(staff({ home_institution_id: 'institution-2' }));
      t.institutionIds.mockResolvedValue(['institution-1']);
      await t.service.grant(owner, 'institution-1', { staffMemberId: 'staff-1' });
      expect(t.grantInstitutionAdmin).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['not found', null, { status: 404, code: 'NOT_FOUND' }],
      ['deactivated', staff({ status: 0 }), { status: 404, code: 'NOT_FOUND' }],
      ['blocked', staff({ access_blocked_at: now }), { status: 422, code: 'STAFF_BLOCKED' }],
      [
        'at another Institution',
        staff({ home_institution_id: 'institution-2' }),
        { status: 422, code: 'STAFF_NOT_AT_INSTITUTION' },
      ],
    ])(
      'refuses a record that is %s, granting and telling nobody',
      async (_name, current, expected) => {
        const t = build(current);
        expect(
          await fail(t.service.grant(owner, 'institution-1', { staffMemberId: 'staff-1' })),
        ).toEqual(expected);
        expect(t.grantInstitutionAdmin).not.toHaveBeenCalled();
        expect(t.record).not.toHaveBeenCalled();
        expect(t.announceAdminAccess).not.toHaveBeenCalled();
      },
    );

    it('tells nobody when the grant is refused', async () => {
      const t = build();
      t.grantInstitutionAdmin.mockRejectedValue(AppException.conflict('ALREADY_ADMIN'));
      expect(
        await fail(t.service.grant(owner, 'institution-1', { staffMemberId: 'staff-1' })),
      ).toEqual({
        status: 409,
        code: 'ALREADY_ADMIN',
      });
      expect(t.record).not.toHaveBeenCalled();
      expect(t.announceAdminAccess).not.toHaveBeenCalled();
    });
  });

  describe('revoke (INS-10)', () => {
    it('revokes, audits who and how many sessions ended, and tells the person after the commit', async () => {
      const t = build();
      await t.service.revoke(owner, 'institution-1', 'staff-1');
      // The record is locked first, so a move or a deactivation in flight finishes before the revoke reads.
      expect(t.find).toHaveBeenCalledWith(expect.anything(), 'staff-1', true);
      expect(t.revokeInstitutionAdmin).toHaveBeenCalledWith(
        expect.anything(),
        'staff-1',
        'institution-1',
        'owner-1',
        'revoked_by_owner',
        now,
      );
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'access.revoke',
        before: { roleCode: 3, institutionId: 'institution-1', personId: 'user-1' },
        after: { sessionsEnded: 2 },
      });
      expect(t.announceAdminAccess).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'meera@example.com' }),
        'revoked',
        'Green Valley',
      );
      expect(t.order).toEqual(['commit', 'announce']);
    });

    it('is 404 for a record that is not there, and passes on the 404 of a missing grant', async () => {
      const gone = build(null);
      expect(await fail(gone.service.revoke(owner, 'institution-1', 'staff-1'))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(gone.revokeInstitutionAdmin).not.toHaveBeenCalled();
      const none = build();
      none.revokeInstitutionAdmin.mockRejectedValue(AppException.notFound());
      expect(await fail(none.service.revoke(owner, 'institution-1', 'staff-1'))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(none.announceAdminAccess).not.toHaveBeenCalled();
    });
  });
});
