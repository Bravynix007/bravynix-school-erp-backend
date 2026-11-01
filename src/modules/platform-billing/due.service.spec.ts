import { Logger } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type {
  BackgroundMailer,
  GrantDirectory,
  PersonDirectory,
} from '../../platform/identity/index.js';
import type { IdempotencyService, IdempotentCall } from '../../platform/idempotency/index.js';
import type { NumberSequenceService } from '../../platform/numbering/index.js';
import type {
  InstitutionDirectory,
  InstitutionName,
  InstitutionRef,
} from '../../platform/tenancy/index.js';
import type {
  CancelDueDto,
  ListDuesQueryDto,
  MarkDuePaidDto,
  RaiseDueDto,
  UpdateDueDto,
} from './due.dto.js';
import type { DueRepository, DueRow, NewDue } from './due.repository.js';
import { DueService } from './due.service.js';
import type { PriceRateRepository, PriceRateRow } from './price-rate.repository.js';

const admin = { personId: 'admin-1', roleCode: 1, societyId: null } as unknown as Principal;
const owner = { personId: 'owner-1', roleCode: 2, societyId: 'society-1' } as unknown as Principal;
const tx = {} as Tx;
const now = '2026-11-01T10:00:00.000Z';

const rate = (overrides: Partial<PriceRateRow> = {}): PriceRateRow => ({
  id: 'rate-1',
  created_at: new Date(now),
  created_by: 'admin-1',
  society_id: 'society-1',
  institution_id: 'inst-1',
  rate_per_student_amount: '50.00',
  effective_from_date: '2026-04-01',
  note: null,
  ...overrides,
});

const row = (values: NewDue): DueRow =>
  ({
    id: 'due-1',
    created_at: new Date(now),
    updated_at: new Date(now),
    updated_by: null,
    version: 1,
    adjustment_note: null,
    student_count_note: null,
    due_date: null,
    due_status: 1,
    paid_date: null,
    payment_mode: null,
    payment_reference: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    ...values,
  }) as DueRow;

const raise = (overrides: Partial<RaiseDueDto> = {}) =>
  ({
    institutionId: 'inst-1',
    periodStartDate: '2026-04-01',
    periodEndDate: '2027-03-31',
    studentCount: 300,
    studentCountNote: 'From the register',
    ...overrides,
  }) as RaiseDueDto;

/** A due as it is stored once raised: 300 students at 50.00, no adjustment, still Due. */
const stored = (overrides: Partial<DueRow> = {}): DueRow =>
  row({
    society_id: 'society-1',
    institution_id: 'inst-1',
    invoice_no: 'BNX/FY2026-27/0007',
    period_start_date: '2026-04-01',
    period_end_date: '2027-03-31',
    student_count_auto: 0,
    student_count: 300,
    student_count_note: 'From the register',
    price_rate_id: 'rate-1',
    rate_per_student_amount: '50.00',
    base_amount: '15000.00',
    adjustment_amount: '0.00',
    total_amount: '15000.00',
    created_by: 'admin-1',
    ...overrides,
  } as NewDue);

const names = new Map<string, InstitutionName>([
  [
    'inst-1',
    { id: 'inst-1', name: 'Green Valley', societyId: 'society-1', societyName: 'Sunrise Trust' },
  ],
]);

type Owner = { id: string; email: string; displayName: string; accountStatus: number };

type IdempotencyRun = (
  call: IdempotentCall,
  work: (tx: Tx) => Promise<{ result: ApiResult<unknown> }>,
) => Promise<ApiResult<unknown>>;

const person = (id: string, accountStatus: number): Owner => ({
  id,
  email: `${id}@demo.test`,
  displayName: id,
  accountStatus,
});

const query = (overrides: Partial<ListDuesQueryDto> = {}) =>
  ({ page: 2, limit: 10, ...overrides }) as ListDuesQueryDto;

function build(options: { institution?: Partial<InstitutionRef> | null; replay?: boolean } = {}) {
  const ref =
    options.institution === null
      ? undefined
      : ({
          id: 'inst-1',
          societyId: 'society-1',
          name: 'Green Valley',
          active: true,
          ...options.institution,
        } as InstitutionRef);
  const tenants: TenantContext[] = [];
  const transaction = vi.fn<DatabaseService['transaction']>((tenant, work) => {
    tenants.push(tenant);
    return work(tx);
  });
  const insert = vi
    .fn<DueRepository['insert']>()
    .mockImplementation((_tx, values) => Promise.resolve(row(values)));
  const find = vi.fn<DueRepository['find']>();
  const update = vi.fn<DueRepository['update']>().mockResolvedValue(undefined);
  const page = vi.fn<DueRepository['page']>().mockResolvedValue({ rows: [], total: 0 });
  const history = vi.fn<PriceRateRepository['history']>().mockResolvedValue([rate()]);
  const findInstitution = vi.fn<InstitutionDirectory['find']>().mockResolvedValue(ref);
  const namesOf = vi.fn<InstitutionDirectory['names']>().mockResolvedValue(names);
  const describe = vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map());
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const calls: IdempotentCall[] = [];
  const run = vi.fn<IdempotencyRun>(
    async (call: IdempotentCall, work: (tx: Tx) => Promise<{ result: ApiResult<unknown> }>) => {
      calls.push(call);
      const { result } = await work(tx);
      return options.replay
        ? new ApiResult(result.data, {
            ...result.options,
            headers: { 'Idempotent-Replayed': 'true' },
          })
        : result;
    },
  );
  const nextPlatformInvoice = vi
    .fn<NumberSequenceService['nextPlatformInvoice']>()
    .mockResolvedValue('BNX/FY2026-27/0007');
  const owners = vi.fn<GrantDirectory['societyOwners']>().mockResolvedValue([] as Owner[]);
  const send = vi.fn<BackgroundMailer['send']>();
  const service = new DueService(
    { transaction } as unknown as DatabaseService,
    { insert, find, update, page } as unknown as DueRepository,
    { history } as unknown as PriceRateRepository,
    { find: findInstitution, names: namesOf } as unknown as InstitutionDirectory,
    { describe } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
    { run } as unknown as IdempotencyService,
    { nextPlatformInvoice } as unknown as NumberSequenceService,
    { societyOwners: owners } as unknown as GrantDirectory,
    { send } as unknown as BackgroundMailer,
    new FixedClock(now),
  );
  return {
    service,
    tenants,
    calls,
    insert,
    find,
    update,
    page,
    history,
    record,
    owners,
    send,
    nextPlatformInvoice,
  };
}

/** The due is found twice before the write (the look-up, then the locked read) and once after. */
function arrangeDue(current: DueRow = stored(), changed: Partial<DueRow> = {}) {
  const t = build();
  let writes = 0;
  t.update.mockImplementation(() => {
    writes += 1;
    return Promise.resolve();
  });
  t.find.mockImplementation(() =>
    Promise.resolve(writes > 0 ? { ...current, ...changed } : current),
  );
  return t;
}

const edit = (overrides: Partial<UpdateDueDto> = {}) =>
  ({ version: 1, ...overrides }) as UpdateDueDto;
const paid = (overrides: Partial<MarkDuePaidDto> = {}) =>
  ({ version: 1, paidDate: '2026-10-30', paymentMode: 2, ...overrides }) as MarkDuePaidDto;
const cancelBody = (overrides: Partial<CancelDueDto> = {}) =>
  ({ version: 1, reason: 'Raised twice', ...overrides }) as CancelDueDto;

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('DueService', () => {
  describe('quote (PLT-24)', () => {
    const period = { periodStartDate: '2026-10-01', periodEndDate: '2027-03-31' };

    it('gives the automatic count and the rate in force on the first day of the period', async () => {
      const { service, history } = build();
      history.mockResolvedValue([
        rate({
          id: 'october',
          rate_per_student_amount: '65.00',
          effective_from_date: '2026-10-01',
        }),
        rate(),
      ]);
      expect(await service.quote(admin, 'inst-1', period)).toEqual({
        institutionId: 'inst-1',
        ...period,
        studentCountAuto: 0,
        priceRateId: 'october',
        ratePerStudentAmount: '65.00',
        rateEffectiveFromDate: '2026-10-01',
        baseAmount: '0.00',
      });
    });

    it('has no rate and no base before the first rate starts, and does not refuse', async () => {
      const { service } = build();
      expect(
        await service.quote(admin, 'inst-1', { ...period, periodStartDate: '2026-03-01' }),
      ).toMatchObject({ priceRateId: null, ratePerStudentAmount: null, baseAmount: null });
    });

    it('refuses an end before the start, an unknown Institution and a caller who is not Super Admin', async () => {
      expect(
        (
          await refusal(
            build().service.quote(admin, 'inst-1', { ...period, periodEndDate: '2026-09-30' }),
          )
        ).status,
      ).toBe(400);
      expect(
        (await refusal(build({ institution: null }).service.quote(admin, 'x', period))).status,
      ).toBe(404);
      expect((await refusal(build().service.quote(owner, 'inst-1', period))).status).toBe(403);
    });
  });

  describe('raise (PLT-26)', () => {
    const key = '0190a000-0000-7000-8000-0000000000aa';

    it('freezes the rate in force at the period start and the amounts on the due, in one idempotent call', async () => {
      const { service, tenants, calls, insert, history, nextPlatformInvoice } = build();
      history.mockResolvedValue([
        rate({ id: 'later', rate_per_student_amount: '65.00', effective_from_date: '2026-10-01' }),
        rate(),
      ]);
      const body = raise({ adjustmentAmount: '-500.00', adjustmentNote: 'Opening discount' });
      const result = await service.raise(admin, key, body);

      expect(calls).toEqual([
        expect.objectContaining({
          key,
          operation: 'billing.raise_due',
          request: body,
          tenant: expect.objectContaining({
            personId: 'admin-1',
            societyId: 'society-1',
            institutionIds: ['inst-1'],
          }),
        }),
      ]);
      expect(tenants.at(0)).not.toHaveProperty('societyId', 'society-1');
      expect(nextPlatformInvoice).toHaveBeenCalledWith(tx, '2026-11-01');
      expect(insert).toHaveBeenCalledWith(tx, {
        society_id: 'society-1',
        institution_id: 'inst-1',
        invoice_no: 'BNX/FY2026-27/0007',
        period_start_date: '2026-04-01',
        period_end_date: '2027-03-31',
        student_count_auto: 0,
        student_count: 300,
        student_count_note: 'From the register',
        price_rate_id: 'rate-1',
        rate_per_student_amount: '50.00',
        base_amount: '15000.00',
        adjustment_amount: '-500.00',
        adjustment_note: 'Opening discount',
        total_amount: '14500.00',
        due_date: null,
        created_by: 'admin-1',
        updated_by: 'admin-1',
      });
      expect(result.options.status).toBe(201);
      expect(result.data).toMatchObject({
        invoiceNo: 'BNX/FY2026-27/0007',
        societyName: 'Sunrise Trust',
        institution: { id: 'inst-1', name: 'Green Valley' },
        totalAmount: '14500.00',
        dueStatus: 1,
      });
    });

    it('audits the due with its Society and Institution in the same transaction', async () => {
      const { service, record } = build();
      await service.raise(admin, key, raise());
      expect(record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: 'platform_due.raise',
          societyId: 'society-1',
          institutionId: 'inst-1',
          entityType: 'platform_due',
          entityId: 'due-1',
          after: expect.objectContaining({
            invoice_no: 'BNX/FY2026-27/0007',
            total_amount: '15000.00',
          }),
        }),
      );
    });

    it.each([
      [
        'NO_RATE_IN_FORCE',
        raise(),
        (t: ReturnType<typeof build>) =>
          t.history.mockResolvedValue([rate({ effective_from_date: '2026-05-01' })]),
      ],
      ['NOTE_REQUIRED', raise({ studentCountNote: undefined }), () => undefined],
      [
        'TOTAL_NEGATIVE',
        raise({ adjustmentAmount: '-99999.00', adjustmentNote: 'x' }),
        () => undefined,
      ],
    ])(
      'takes no invoice number and writes nothing when the answer is %s',
      async (code, body, arrange) => {
        const t = build();
        arrange(t);
        expect((await refusal(t.service.raise(admin, key, body))).code).toBe(code);
        expect(t.nextPlatformInvoice).not.toHaveBeenCalled();
        expect(t.insert).not.toHaveBeenCalled();
        expect(t.record).not.toHaveBeenCalled();
      },
    );

    it('refuses an Institution or Society that is no longer active, 409 INVALID_STATE', async () => {
      const { service, insert } = build({ institution: { active: false } });
      const error = await refusal(service.raise(admin, key, raise()));
      expect([error.status, error.code]).toEqual([409, 'INVALID_STATE']);
      expect(insert).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown Institution and 400 for a period that ends before it starts, before anything is read', async () => {
      const unknown = build({ institution: null });
      expect((await refusal(unknown.service.raise(admin, key, raise()))).status).toBe(404);
      expect(unknown.calls).toEqual([]);
      const backwards = build();
      expect(
        (await refusal(backwards.service.raise(admin, key, raise({ periodEndDate: '2026-03-31' }))))
          .status,
      ).toBe(400);
      expect(backwards.tenants).toEqual([]);
    });

    it('refuses a caller who is not Super Admin before it reads anything', async () => {
      const { service, calls } = build();
      expect((await refusal(service.raise(owner, key, raise()))).status).toBe(403);
      expect(calls).toEqual([]);
    });

    describe('telling the Owners', () => {
      it('emails each Owner who can sign in, once, and not an Owner who is blocked', async () => {
        const { service, owners, send } = build();
        owners.mockResolvedValue([person('asha', 1), person('blocked', 2), person('meera', 1)]);
        await service.raise(admin, key, raise());
        expect(owners).toHaveBeenCalledWith('society-1');
        expect(send.mock.calls.map(([mail]) => mail.to)).toEqual([
          'asha@demo.test',
          'meera@demo.test',
        ]);
        expect(send.mock.calls[0]![0]).toMatchObject({ template: 'platform-due-raised' });
      });

      it('sends nothing when the answer is a replay of the stored one', async () => {
        const { service, owners, send } = build({ replay: true });
        owners.mockResolvedValue([person('asha', 1)]);
        const result = await service.raise(admin, key, raise());
        expect(result.options.headers).toEqual({ 'Idempotent-Replayed': 'true' });
        expect(owners).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      });

      it('still answers 201 when the Owners cannot be looked up, because the due is saved', async () => {
        const { service, owners, send } = build();
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        owners.mockRejectedValue(new Error('connection lost'));
        const result = await service.raise(admin, key, raise());
        expect(result.options.status).toBe(201);
        expect(send).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
      });

      it('sends nothing when the due is refused', async () => {
        const { service, owners, send } = build({ institution: { active: false } });
        owners.mockResolvedValue([person('asha', 1)]);
        await refusal(service.raise(admin, key, raise()));
        expect(send).not.toHaveBeenCalled();
      });
    });
  });

  describe('list (PLT-25)', () => {
    it('passes the filters, the page and the sort on, newest first by default', async () => {
      const { service, page } = build();
      const result = await service.list(
        admin,
        query({ q: 'FY2026', societyId: 's', institutionId: 'i', dueStatus: [1, 2] }),
      );
      expect(page).toHaveBeenCalledWith(
        tx,
        { q: 'FY2026', societyId: 's', institutionId: 'i', statuses: [1, 2] },
        [{ field: 'createdAt', direction: 'desc' }],
        10,
        10,
      );
      expect(result.options.meta).toEqual({ page: 2, limit: 10, totalItems: 0, totalPages: 0 });
    });

    it('sorts by the fields it allows and refuses the rest with 400 INVALID_SORT', async () => {
      const { service, page } = build();
      await service.list(admin, query({ sort: '-totalAmount,invoiceNo' }));
      expect(page.mock.calls[0]![2]).toEqual([
        { field: 'totalAmount', direction: 'desc' },
        { field: 'invoiceNo', direction: 'asc' },
      ]);
      expect((await refusal(service.list(admin, query({ sort: 'societyName' })))).code).toBe(
        'INVALID_SORT',
      );
    });

    it('names the Society and Institution of each line', async () => {
      const { service, page } = build();
      page.mockResolvedValue({
        rows: [row({ ...({} as NewDue), institution_id: 'inst-1', society_id: 'society-1' })],
        total: 1,
      });
      const result = await service.list(admin, query());
      expect(result.data).toEqual([
        expect.objectContaining({
          societyName: 'Sunrise Trust',
          institution: { id: 'inst-1', name: 'Green Valley' },
        }),
      ]);
    });

    it('refuses a caller who is not Super Admin', async () => {
      expect((await refusal(build().service.list(owner, query()))).status).toBe(403);
    });
  });

  describe('get (PLT-27)', () => {
    it('answers 404 for an unknown due and 403 for a caller who is not Super Admin', async () => {
      const { service, find } = build();
      find.mockResolvedValue(undefined);
      expect((await refusal(service.get(admin, 'due-9'))).status).toBe(404);
      expect((await refusal(service.get(owner, 'due-1'))).status).toBe(403);
    });

    it('returns the due with the names and the people who made it', async () => {
      const { service, find } = build();
      find.mockResolvedValue(
        row({ institution_id: 'inst-1', society_id: 'society-1', created_by: 'admin-1' } as NewDue),
      );
      expect(await service.get(admin, 'due-1')).toMatchObject({
        id: 'due-1',
        societyName: 'Sunrise Trust',
        institution: { name: 'Green Valley' },
        version: 1,
      });
    });
  });
  describe('the lifecycle (PLT-28 to PLT-30)', () => {
    describe('shared rules', () => {
      it.each([
        [
          'edit',
          (t: ReturnType<typeof build>) =>
            t.service.edit(admin, 'due-1', edit({ studentCount: 1 })),
        ],
        ['mark paid', (t: ReturnType<typeof build>) => t.service.markPaid(admin, 'due-1', paid())],
        ['cancel', (t: ReturnType<typeof build>) => t.service.cancel(admin, 'due-1', cancelBody())],
      ])(
        '%s: 404 for an unknown due, 403 for a caller who is not Super Admin',
        async (_name, call) => {
          const unknown = build();
          unknown.find.mockResolvedValue(undefined);
          expect((await refusal(call(unknown))).status).toBe(404);
          expect(unknown.update).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['edit', (t: ReturnType<typeof build>) => t.service.edit(owner, 'due-1', edit())],
        ['mark paid', (t: ReturnType<typeof build>) => t.service.markPaid(owner, 'due-1', paid())],
        ['cancel', (t: ReturnType<typeof build>) => t.service.cancel(owner, 'due-1', cancelBody())],
      ])('%s: refused for an Owner before anything is read', async (_name, call) => {
        const t = build();
        expect((await refusal(call(t))).status).toBe(403);
        expect(t.find).not.toHaveBeenCalled();
      });

      it.each([
        [
          'edit',
          (t: ReturnType<typeof build>) => t.service.edit(admin, 'due-1', edit({ version: 4 })),
        ],
        [
          'mark paid',
          (t: ReturnType<typeof build>) => t.service.markPaid(admin, 'due-1', paid({ version: 4 })),
        ],
        [
          'cancel',
          (t: ReturnType<typeof build>) =>
            t.service.cancel(admin, 'due-1', cancelBody({ version: 4 })),
        ],
      ])(
        '%s: a stale version is VERSION_CONFLICT, even for a due that is final',
        async (_name, call) => {
          const t = arrangeDue(stored({ due_status: 2 }));
          const error = await refusal(call(t));
          expect([error.status, error.code]).toEqual([409, 'VERSION_CONFLICT']);
          expect(t.update).not.toHaveBeenCalled();
          expect(t.record).not.toHaveBeenCalled();
        },
      );

      it.each([
        [
          'edit',
          (t: ReturnType<typeof build>) =>
            t.service.edit(admin, 'due-1', edit({ studentCount: 1 })),
        ],
        ['mark paid', (t: ReturnType<typeof build>) => t.service.markPaid(admin, 'due-1', paid())],
        ['cancel', (t: ReturnType<typeof build>) => t.service.cancel(admin, 'due-1', cancelBody())],
      ])('%s: a Paid or Cancelled due is final, 409 INVALID_STATE', async (_name, call) => {
        for (const status of [0, 2]) {
          const t = arrangeDue(stored({ due_status: status }));
          const error = await refusal(call(t));
          expect([error.status, error.code]).toEqual([409, 'INVALID_STATE']);
          expect(t.update).not.toHaveBeenCalled();
          expect(t.record).not.toHaveBeenCalled();
        }
      });

      it('locks the row it checks, and writes in a transaction that names the Society and Institution', async () => {
        const t = arrangeDue();
        await t.service.cancel(admin, 'due-1', cancelBody());
        expect(t.find.mock.calls.map(([, , lock]) => lock ?? false)).toEqual([false, true, false]);
        expect(t.tenants.at(-1)).toMatchObject({
          personId: 'admin-1',
          societyId: 'society-1',
          institutionIds: ['inst-1'],
        });
      });
    });

    describe('edit (PLT-28)', () => {
      it('works the totals out again from the frozen rate and stamps and audits the change', async () => {
        const t = arrangeDue(stored(), {
          student_count: 320,
          base_amount: '16000.00',
          total_amount: '16000.00',
          version: 2,
        });
        const result = await t.service.edit(admin, 'due-1', edit({ studentCount: 320 }));

        expect(t.history).not.toHaveBeenCalled();
        expect(t.update).toHaveBeenCalledWith(
          tx,
          'due-1',
          expect.objectContaining({
            student_count: 320,
            price_rate_id: 'rate-1',
            rate_per_student_amount: '50.00',
            base_amount: '16000.00',
            total_amount: '16000.00',
            updated_by: 'admin-1',
          }),
        );
        expect(t.record).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            action: 'platform_due.edit',
            societyId: 'society-1',
            institutionId: 'inst-1',
            entityType: 'platform_due',
            entityId: 'due-1',
            before: expect.objectContaining({ student_count: 300, total_amount: '15000.00' }),
            after: expect.objectContaining({ student_count: 320, total_amount: '16000.00' }),
          }),
        );
        expect(result).toMatchObject({ studentCount: 320, totalAmount: '16000.00', version: 2 });
      });

      it('leaves a field that is not named as it was, and clears a note or the due date named null', async () => {
        const t = arrangeDue(
          stored({
            adjustment_amount: '-500.00',
            adjustment_note: 'Discount',
            total_amount: '14500.00',
            due_date: '2026-05-15',
          }),
        );
        await t.service.edit(
          admin,
          'due-1',
          edit({ adjustmentAmount: '0.00', adjustmentNote: null, dueDate: null }),
        );
        expect(t.update).toHaveBeenCalledWith(
          tx,
          'due-1',
          expect.objectContaining({
            adjustment_amount: '0.00',
            adjustment_note: null,
            due_date: null,
            total_amount: '15000.00',
            student_count: 300,
            student_count_note: 'From the register',
          }),
        );
      });

      it('takes the rate in force on a new period start, and only then', async () => {
        const t = arrangeDue();
        t.history.mockResolvedValue([
          rate({
            id: 'october',
            rate_per_student_amount: '65.00',
            effective_from_date: '2026-10-01',
          }),
          rate(),
        ]);
        await t.service.edit(admin, 'due-1', edit({ periodStartDate: '2026-10-01' }));
        expect(t.history).toHaveBeenCalledWith(tx, 'inst-1');
        expect(t.update).toHaveBeenCalledWith(
          tx,
          'due-1',
          expect.objectContaining({
            period_start_date: '2026-10-01',
            price_rate_id: 'october',
            rate_per_student_amount: '65.00',
            base_amount: '19500.00',
            total_amount: '19500.00',
          }),
        );
      });

      it('answers 422 NO_RATE_IN_FORCE when no rate applies on the new start, and writes nothing', async () => {
        const t = arrangeDue();
        t.history.mockResolvedValue([rate({ effective_from_date: '2026-05-01' })]);
        const error = await refusal(
          t.service.edit(admin, 'due-1', edit({ periodStartDate: '2026-04-15' })),
        );
        expect([error.status, error.code]).toEqual([422, 'NO_RATE_IN_FORCE']);
        expect(t.update).not.toHaveBeenCalled();
      });

      it.each([
        ['an end before the start', { periodEndDate: '2026-03-31' }, 400, 'VALIDATION_FAILED'],
        [
          'a new count without a note',
          { studentCount: 310, studentCountNote: null },
          422,
          'NOTE_REQUIRED',
        ],
        ['an adjustment without a note', { adjustmentAmount: '-10.00' }, 422, 'NOTE_REQUIRED'],
        [
          'a total below zero',
          { adjustmentAmount: '-99999.00', adjustmentNote: 'x' },
          422,
          'TOTAL_NEGATIVE',
        ],
      ])('refuses %s with %i %s and writes nothing', async (_name, body, status, code) => {
        const t = arrangeDue();
        const error = await refusal(t.service.edit(admin, 'due-1', edit(body)));
        expect([error.status, error.code]).toEqual([status, code]);
        expect(t.update).not.toHaveBeenCalled();
        expect(t.record).not.toHaveBeenCalled();
      });

      it.each(['-0.00', '000.00', '0.00'])(
        'compares an amount by value: %s is no change from 0.00',
        async (spelling) => {
          const t = arrangeDue();
          await t.service.edit(admin, 'due-1', edit({ adjustmentAmount: spelling }));
          expect(t.update).not.toHaveBeenCalled();
          expect(t.record).not.toHaveBeenCalled();
        },
      );

      it('writes nothing and keeps the version when the request changes nothing', async () => {
        const t = arrangeDue();
        const result = await t.service.edit(
          admin,
          'due-1',
          edit({
            studentCount: 300,
            periodStartDate: '2026-04-01',
            adjustmentAmount: '0.00',
            dueDate: null,
          }),
        );
        expect(t.update).not.toHaveBeenCalled();
        expect(t.record).not.toHaveBeenCalled();
        expect(result).toMatchObject({ id: 'due-1', version: 1 });
      });
    });

    describe('mark paid (PLT-29)', () => {
      it('records the date, mode and reference, ends the due Paid and audits it', async () => {
        const t = arrangeDue(stored(), {
          due_status: 2,
          paid_date: '2026-10-30',
          payment_mode: 2,
          payment_reference: 'UTR 4821',
          version: 2,
        });
        const result = await t.service.markPaid(
          admin,
          'due-1',
          paid({ paymentReference: 'UTR 4821' }),
        );
        expect(t.update).toHaveBeenCalledWith(tx, 'due-1', {
          due_status: 2,
          paid_date: '2026-10-30',
          payment_mode: 2,
          payment_reference: 'UTR 4821',
          updated_by: 'admin-1',
        });
        expect(t.record).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            action: 'platform_due.mark_paid',
            before: expect.objectContaining({ due_status: 1, paid_date: null }),
            after: expect.objectContaining({
              due_status: 2,
              paid_date: '2026-10-30',
              payment_mode: 2,
            }),
          }),
        );
        expect(result).toMatchObject({ dueStatus: 2, version: 2 });
      });

      it('keeps no reference when none is given', async () => {
        const t = arrangeDue();
        await t.service.markPaid(admin, 'due-1', paid());
        expect(t.update).toHaveBeenCalledWith(
          tx,
          'due-1',
          expect.objectContaining({ payment_reference: null }),
        );
      });

      it('accepts today in India and refuses tomorrow with 400 on paidDate', async () => {
        const today = arrangeDue();
        await today.service.markPaid(admin, 'due-1', paid({ paidDate: '2026-11-01' }));
        expect(today.update).toHaveBeenCalledOnce();

        const tomorrow = arrangeDue();
        const error = await refusal(
          tomorrow.service.markPaid(admin, 'due-1', paid({ paidDate: '2026-11-02' })),
        );
        expect([error.status, error.code]).toEqual([400, 'VALIDATION_FAILED']);
        expect(tomorrow.update).not.toHaveBeenCalled();
      });
    });

    describe('cancel (PLT-30)', () => {
      it('ends the due Cancelled with who, when and why, and audits it', async () => {
        const t = arrangeDue(stored(), {
          due_status: 0,
          cancelled_by: 'admin-1',
          cancel_reason: 'Raised twice',
          version: 2,
        });
        const result = await t.service.cancel(admin, 'due-1', cancelBody());
        expect(t.update).toHaveBeenCalledWith(
          tx,
          'due-1',
          expect.objectContaining({
            due_status: 0,
            cancelled_at: new Date(now),
            cancelled_by: 'admin-1',
            cancel_reason: 'Raised twice',
            updated_by: 'admin-1',
          }),
        );
        expect(t.record).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            action: 'platform_due.cancel',
            before: expect.objectContaining({ due_status: 1, cancel_reason: null }),
            after: expect.objectContaining({ due_status: 0, cancel_reason: 'Raised twice' }),
          }),
        );
        expect(result).toMatchObject({ dueStatus: 0, version: 2 });
      });

      it('sends no email to the Owners', async () => {
        const t = arrangeDue();
        t.owners.mockResolvedValue([person('asha', 1)]);
        await t.service.cancel(admin, 'due-1', cancelBody());
        expect(t.send).not.toHaveBeenCalled();
      });
    });
  });
});
