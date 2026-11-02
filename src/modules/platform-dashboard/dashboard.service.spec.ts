import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { InstitutionDirectory } from '../../platform/tenancy/index.js';
import type { DueFigures } from '../platform-billing/index.js';
import { DashboardService } from './dashboard.service.js';

const admin = { personId: 'admin-1', roleCode: 1, societyId: null } as unknown as Principal;
const owner = { personId: 'owner-1', roleCode: 2, societyId: 'society-1' } as unknown as Principal;
const tx = {} as Tx;

function build(now = '2026-11-02T10:00:00.000Z') {
  const tenants: TenantContext[] = [];
  const transaction = vi.fn<DatabaseService['transaction']>((tenant, work) => {
    tenants.push(tenant);
    return work(tx);
  });
  const activeCounts = vi
    .fn<InstitutionDirectory['activeCounts']>()
    .mockResolvedValue({ societies: 3, institutions: 5 });
  const outstandingTotal = vi.fn<DueFigures['outstandingTotal']>().mockResolvedValue('41250.00');
  const collectedBetween = vi
    .fn<DueFigures['collectedBetween']>()
    .mockImplementation((_tx, from) =>
      Promise.resolve(from === '2026-11-01' ? '18000.00' : '13750.00'),
    );
  const service = new DashboardService(
    { transaction } as unknown as DatabaseService,
    { activeCounts } as unknown as InstitutionDirectory,
    { outstandingTotal, collectedBetween } as unknown as DueFigures,
    new FixedClock(now),
  );
  return { service, tenants, activeCounts, outstandingTotal, collectedBetween };
}

describe('DashboardService (PLT-01)', () => {
  it('gives the counts and the dues figures, with students and AI reports not available yet', async () => {
    const { service } = build();
    expect(await service.get(admin)).toEqual({
      societies: 3,
      institutions: 5,
      activeStudents: null,
      duesOutstandingAmount: '41250.00',
      duesCollectedThisMonthAmount: '18000.00',
      duesCollectedLastMonthAmount: '13750.00',
      openAiReports: null,
    });
  });

  it('asks for this month and last month by the date in India', async () => {
    // 19:00 UTC on 31 October is already 1 November in India.
    const { service, collectedBetween } = build('2026-10-31T19:00:00.000Z');
    await service.get(admin);
    expect(collectedBetween.mock.calls.map(([, from, before]) => [from, before])).toEqual([
      ['2026-11-01', '2026-12-01'],
      ['2026-10-01', '2026-11-01'],
    ]);
  });

  it('reads in one Super Admin transaction', async () => {
    const { service, tenants } = build();
    await service.get(admin);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({ roleCode: 1, personId: 'admin-1' });
  });

  it('refuses a caller who is not Super Admin before it reads anything', async () => {
    const { service, activeCounts } = build();
    const error = await service.get(owner).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).status).toBe(403);
    expect(activeCounts).not.toHaveBeenCalled();
  });
});
