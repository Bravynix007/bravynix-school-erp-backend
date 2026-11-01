import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { InstitutionDirectory, InstitutionRef } from '../../platform/tenancy/index.js';
import type { SetPriceRateDto } from './price-rate.dto.js';
import type { PriceRateRepository, PriceRateRow } from './price-rate.repository.js';
import { PriceRateService } from './price-rate.service.js';

const admin = { personId: 'admin-1', roleCode: 1, societyId: null } as unknown as Principal;
const owner = { personId: 'owner-1', roleCode: 2, societyId: 'society-1' } as unknown as Principal;
const tx = {} as Tx;
const now = '2026-10-28T10:00:00.000Z';

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

const body = (overrides: Partial<SetPriceRateDto> = {}) =>
  ({
    ratePerStudentAmount: '50.00',
    effectiveFromDate: '2026-04-01',
    ...overrides,
  }) as SetPriceRateDto;

function build(institution: Partial<InstitutionRef> | null = {}, clockAt = now) {
  const ref =
    institution === null
      ? undefined
      : ({
          id: 'inst-1',
          societyId: 'society-1',
          name: 'Green Valley',
          active: true,
          ...institution,
        } as InstitutionRef);
  const tenants: TenantContext[] = [];
  const transaction = vi.fn<DatabaseService['transaction']>((tenant, work) => {
    tenants.push(tenant);
    return work(tx);
  });
  const insert = vi
    .fn<PriceRateRepository['insert']>()
    .mockImplementation((_tx, values) => Promise.resolve(rate(values as Partial<PriceRateRow>)));
  const history = vi.fn<PriceRateRepository['history']>().mockResolvedValue([rate()]);
  const find = vi.fn<InstitutionDirectory['find']>().mockResolvedValue(ref);
  const describe = vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map());
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new PriceRateService(
    { transaction } as unknown as DatabaseService,
    { insert, history } as unknown as PriceRateRepository,
    { find } as unknown as InstitutionDirectory,
    { describe } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
    new FixedClock(clockAt),
  );
  return { service, tenants, insert, history, find, record };
}

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('PriceRateService', () => {
  describe('history (PLT-22)', () => {
    it('lists the rates and marks the one in force today', async () => {
      const { service, history } = build();
      history.mockResolvedValue([
        rate({ id: 'later', effective_from_date: '2027-04-01' }),
        rate({ id: 'now', effective_from_date: '2026-10-01' }),
        rate({ id: 'first', effective_from_date: '2026-04-01' }),
      ]);
      const result = await service.history(admin, 'inst-1');
      expect(result.data.map((r) => [r.id, r.inForce])).toEqual([
        ['later', false],
        ['now', true],
        ['first', false],
      ]);
    });

    it('counts the day in India: 00:30 IST on 1 October already has the October rate in force', async () => {
      // 2026-09-30T19:00Z is 2026-10-01 00:30 in IST, though the UTC day is still 30 September.
      const { service, history } = build({}, '2026-09-30T19:00:00.000Z');
      history.mockResolvedValue([
        rate({ id: 'october', effective_from_date: '2026-10-01' }),
        rate({ id: 'april', effective_from_date: '2026-04-01' }),
      ]);
      const result = await service.history(admin, 'inst-1');
      expect(result.data.map((r) => [r.id, r.inForce])).toEqual([
        ['october', true],
        ['april', false],
      ]);
    });

    it('answers 404 for an Institution nobody can see', async () => {
      const { service } = build(null);
      expect((await refusal(service.history(admin, 'inst-9'))).status).toBe(404);
    });

    it('refuses a caller who is not Super Admin before it reads anything', async () => {
      const { service, find } = build();
      expect((await refusal(service.history(owner, 'inst-1'))).status).toBe(403);
      expect(find).not.toHaveBeenCalled();
    });
  });

  describe('set (PLT-23)', () => {
    it('adds the rate in a transaction that names the Society and Institution, with its audit entry', async () => {
      const { service, tenants, insert, record } = build();
      const result = await service.set(admin, 'inst-1', body({ note: 'Agreed' }));
      expect(tenants.at(-1)).toMatchObject({ societyId: 'society-1', institutionIds: ['inst-1'] });
      expect(insert).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          society_id: 'society-1',
          institution_id: 'inst-1',
          rate_per_student_amount: '50.00',
          effective_from_date: '2026-04-01',
          note: 'Agreed',
          created_by: 'admin-1',
        }),
      );
      expect(record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: 'price_rate.set',
          societyId: 'society-1',
          institutionId: 'inst-1',
          entityType: 'institution_price_rate',
        }),
      );
      expect(result).toMatchObject({ ratePerStudentAmount: '50.00', inForce: true });
    });

    it('does not mark a rate that starts later as in force', async () => {
      const { service, history, insert } = build();
      const future = rate({ id: 'rate-2', effective_from_date: '2027-04-01' });
      insert.mockResolvedValue(future);
      history.mockResolvedValue([future, rate()]);
      const result = await service.set(admin, 'inst-1', body({ effectiveFromDate: '2027-04-01' }));
      expect(result.inForce).toBe(false);
    });

    it('turns a second rate for the same date into 409 DUPLICATE on effectiveFromDate', async () => {
      const { service, insert } = build();
      insert.mockRejectedValue(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'uq_institution_price_rates_effective',
        }),
      );
      const error = await refusal(service.set(admin, 'inst-1', body()));
      expect(error.status).toBe(409);
      expect(error.options.errors).toEqual([
        expect.objectContaining({ field: 'effectiveFromDate', code: 'DUPLICATE' }),
      ]);
    });

    it('takes no rate for a deactivated Institution or Society, 409 INVALID_STATE', async () => {
      const { service, insert, record } = build({ active: false });
      const error = await refusal(service.set(admin, 'inst-1', body()));
      expect(error.status).toBe(409);
      expect(error.code).toBe('INVALID_STATE');
      expect(insert).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown Institution and 403 for a caller who is not Super Admin', async () => {
      expect((await refusal(build(null).service.set(admin, 'inst-9', body()))).status).toBe(404);
      expect((await refusal(build().service.set(owner, 'inst-1', body()))).status).toBe(403);
    });
  });
});
