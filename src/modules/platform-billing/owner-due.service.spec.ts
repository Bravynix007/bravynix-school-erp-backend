import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type {
  InstitutionDirectory,
  InstitutionName,
  ScopeService,
} from '../../platform/tenancy/index.js';
import type { DueRepository, DueRow } from './due.repository.js';
import { OwnerDueService } from './owner-due.service.js';

const owner = { personId: 'owner-1', roleCode: 2, societyId: 'society-1' } as unknown as Principal;
const tx = {} as Tx;
const tenant = { societyId: 'society-1', roleCode: 2 } as TenantContext;

const names = new Map<string, InstitutionName>([
  [
    'inst-1',
    { id: 'inst-1', name: 'Green Valley', societyId: 'society-1', societyName: 'Sunrise Trust' },
  ],
]);

const due = (overrides: Partial<DueRow> = {}): DueRow =>
  ({
    id: 'due-1',
    society_id: 'society-1',
    institution_id: 'inst-1',
    invoice_no: 'BNX/FY2026-27/0007',
    period_start_date: '2026-04-01',
    period_end_date: '2027-03-31',
    student_count: 300,
    student_count_note: 'Internal count note',
    price_rate_id: 'rate-1',
    rate_per_student_amount: '50.00',
    base_amount: '15000.00',
    adjustment_amount: '-500.00',
    adjustment_note: 'Opening discount',
    total_amount: '14500.00',
    due_date: '2026-05-15',
    due_status: 1,
    paid_date: null,
    payment_mode: null,
    payment_reference: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    created_by: 'admin-1',
    updated_by: 'admin-1',
    version: 3,
    ...overrides,
  }) as DueRow;

function build() {
  const tenants: TenantContext[] = [];
  const transaction = vi.fn<DatabaseService['transaction']>((context, work) => {
    tenants.push(context);
    return work(tx);
  });
  const all = vi.fn<DueRepository['all']>().mockResolvedValue([]);
  const find = vi.fn<DueRepository['find']>();
  const namesOf = vi.fn<InstitutionDirectory['names']>().mockResolvedValue(names);
  const forPrincipal = vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({ tenant } as never);
  const service = new OwnerDueService(
    { transaction } as unknown as DatabaseService,
    { all, find } as unknown as DueRepository,
    { names: namesOf } as unknown as InstitutionDirectory,
    { forPrincipal } as unknown as ScopeService,
  );
  return { service, tenants, all, find, namesOf, forPrincipal };
}

describe('OwnerDueService', () => {
  describe('list (BIL-01)', () => {
    it('reads in the Owner’s own tenant and totals only the dues still Due', async () => {
      const { service, all, tenants, forPrincipal } = build();
      all.mockResolvedValue([
        due({ id: 'a', total_amount: '14500.00' }),
        due({
          id: 'b',
          due_status: 2,
          paid_date: '2026-05-10',
          payment_mode: 2,
          total_amount: '9000.00',
        }),
        due({ id: 'c', due_status: 0, total_amount: '700.00' }),
        due({ id: 'd', total_amount: '500.50' }),
      ]);
      const result = await service.list(owner);
      expect(forPrincipal).toHaveBeenCalledWith(owner);
      expect(tenants).toEqual([tenant]);
      expect(result.banner).toEqual({ totalDueAmount: '15000.50', hasOpenDues: true });
      expect(result.dues.map((line) => line.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('reads all paid when nothing is owed: none Due, none at all, or only dues of 0.00', async () => {
      const { service, all } = build();
      all.mockResolvedValue([due({ due_status: 2, paid_date: '2026-05-10', payment_mode: 1 })]);
      expect((await service.list(owner)).banner).toEqual({
        totalDueAmount: '0.00',
        hasOpenDues: false,
      });
      all.mockResolvedValue([due({ total_amount: '0.00', base_amount: '0.00' })]);
      const free = await service.list(owner);
      expect(free.banner).toEqual({ totalDueAmount: '0.00', hasOpenDues: false });
      expect(free.dues).toHaveLength(1);
      all.mockResolvedValue([]);
      expect(await service.list(owner)).toEqual({
        banner: { totalDueAmount: '0.00', hasOpenDues: false },
        dues: [],
      });
    });

    it('gives a line only what an Owner needs, with the Institution named and no invoice file yet', async () => {
      const { service, all } = build();
      all.mockResolvedValue([
        due({
          due_status: 2,
          paid_date: '2026-05-10',
          payment_mode: 3,
          payment_reference: 'UPI 90417',
        }),
      ]);
      expect((await service.list(owner)).dues).toEqual([
        {
          id: 'due-1',
          invoiceNo: 'BNX/FY2026-27/0007',
          institution: { id: 'inst-1', name: 'Green Valley' },
          periodStartDate: '2026-04-01',
          periodEndDate: '2027-03-31',
          totalAmount: '14500.00',
          dueStatus: 2,
          dueDate: '2026-05-15',
          paidDate: '2026-05-10',
          paymentMode: 3,
          paymentReference: 'UPI 90417',
          invoiceFile: null,
        },
      ]);
    });
  });

  describe('get (BIL-02)', () => {
    it('gives the charge in full and keeps BravyNix’s notes and stamps out', async () => {
      const { service, find } = build();
      find.mockResolvedValue(due());
      const result = await service.get(owner, 'due-1');
      expect(find).toHaveBeenCalledWith(tx, 'due-1');
      expect(result).toMatchObject({
        id: 'due-1',
        studentCount: 300,
        ratePerStudentAmount: '50.00',
        baseAmount: '15000.00',
        adjustmentAmount: '-500.00',
        adjustmentNote: 'Opening discount',
        totalAmount: '14500.00',
        invoiceFile: null,
      });
      const text = JSON.stringify(result);
      for (const hidden of [
        'Internal count note',
        'cancel',
        'created_by',
        'admin-1',
        'version',
        'rate-1',
      ]) {
        expect(text).not.toContain(hidden);
      }
    });

    it('answers 404 for a due the Owner’s tenant cannot see', async () => {
      const { service, find } = build();
      find.mockResolvedValue(undefined);
      const error = await service.get(owner, 'due-9').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).status).toBe(404);
    });
  });
});
