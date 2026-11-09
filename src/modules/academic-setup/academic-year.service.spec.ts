import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';
import type { AcademicYearRepository, AcademicYearRow } from './academic-year.repository.js';
import { AcademicYearService } from './academic-year.service.js';
import type { TeachingStaff } from './teaching-staff.js';

const owner = {
  personId: 'owner-1',
  sessionId: 'session-1',
  roleCode: 2,
  societyId: 'society-1',
  clientType: 'mobile',
  viaSupportAccess: false,
} as Principal;

const tenant: TenantContext = {
  personId: 'owner-1',
  roleCode: 2,
  societyId: 'society-1',
  institutionIds: ['inst-1'],
};
const context: InstitutionContext = { institutionId: 'inst-1', societyId: 'society-1', tenant };

const year = (overrides: Partial<AcademicYearRow> = {}): AcademicYearRow => ({
  id: 'year-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'owner-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'owner-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  name: '2026-2027',
  start_date: '2026-06-01',
  end_date: '2027-03-31',
  is_current: false,
  ...overrides,
});

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

const teacher = { ...owner, personId: 'teacher-1', roleCode: 4 } as Principal;

function build(current: AcademicYearRow | null = year(), hasActive = true) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const lockInstitution = vi.fn<AcademicYearRepository['lockInstitution']>().mockResolvedValue();
  const active = vi.fn<AcademicYearRepository['active']>().mockResolvedValue([year()]);
  const find = vi.fn<AcademicYearRepository['find']>().mockResolvedValue(current ?? undefined);
  const hasActiveFn = vi.fn<AcademicYearRepository['hasActive']>().mockResolvedValue(hasActive);
  const currentOf = vi
    .fn<AcademicYearRepository['currentOf']>()
    .mockResolvedValue(year({ id: 'year-0', is_current: true }));
  const insert = vi
    .fn<AcademicYearRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(year({ ...(values as Partial<AcademicYearRow>), id: 'year-new' })),
    );
  const update = vi
    .fn<AcademicYearRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(
        year({ ...current, ...(changes as Partial<AcademicYearRow>), id, version: 2 }),
      ),
    );
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant } as Awaited<ReturnType<ScopeService['forPrincipal']>>);
  const ownYearIds = vi.fn<TeachingStaff['ownYearIds']>().mockResolvedValue(new Set(['year-1']));
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new AcademicYearService(
    { transaction } as unknown as DatabaseService,
    {
      lockInstitution,
      active,
      find,
      hasActive: hasActiveFn,
      currentOf,
      insert,
      update,
    } as unknown as AcademicYearRepository,
    { requireInstitution, forPrincipal } as unknown as ScopeService,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { ownYearIds } as unknown as TeachingStaff,
    { record } as unknown as AuditService,
  );
  return { service, lockInstitution, ownYearIds, active, find, currentOf, insert, update, record };
}

const body = {
  institutionId: 'inst-1',
  name: '2027-2028',
  startDate: '2027-06-01',
  endDate: '2028-03-31',
};

describe('AcademicYearService', () => {
  describe('list (AY-01)', () => {
    it('lists the active years of the Institution in scope, with no meta', async () => {
      const t = build();
      const result = await t.service.list(owner, { institutionId: 'inst-1' });
      expect(result.data).toEqual([expect.objectContaining({ id: 'year-1', name: '2026-2027' })]);
      expect(t.active).toHaveBeenCalledWith(expect.anything(), 'inst-1');
      expect(t.ownYearIds).not.toHaveBeenCalled();
    });

    it('shows a teacher only the years in which they hold an assignment', async () => {
      const t = build();
      t.ownYearIds.mockResolvedValue(new Set(['year-1', 'year-2']));
      const result = await t.service.list(teacher, { institutionId: 'inst-1' });
      expect(result.data).toHaveLength(1);
      expect(t.ownYearIds).toHaveBeenCalledWith(expect.anything(), 'teacher-1', 'inst-1');
      expect(t.active).toHaveBeenCalledWith(expect.anything(), 'inst-1', ['year-1', 'year-2']);
    });

    it('shows a teacher with no assignment no year, without asking the database', async () => {
      const t = build();
      t.ownYearIds.mockResolvedValue(new Set());
      const result = await t.service.list(teacher, { institutionId: 'inst-1' });
      expect(result.data).toEqual([]);
      expect(t.active).not.toHaveBeenCalled();
    });
  });

  describe('create (AY-02)', () => {
    it('makes the first year current, under the Institution lock, with its audit entry', async () => {
      const t = build(null, false);
      const created = await t.service.create(owner, body);
      expect(t.lockInstitution).toHaveBeenCalledWith(expect.anything(), 'inst-1');
      expect(t.insert.mock.calls[0]![1]).toMatchObject({
        society_id: 'society-1',
        institution_id: 'inst-1',
        is_current: true,
      });
      expect(created).toMatchObject({ isCurrent: true });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'academic_year.created',
        societyId: 'society-1',
        institutionId: 'inst-1',
        entityType: 'academic_year',
      });
    });

    it('does not make a later year current', async () => {
      const t = build(null, true);
      await t.service.create(owner, body);
      expect(t.insert.mock.calls[0]![1]).toMatchObject({ is_current: false });
    });

    it('refuses an end on or before the start before writing', async () => {
      const t = build();
      expect(
        await fail(t.service.create(owner, { ...body, endDate: body.startDate })),
      ).toMatchObject({ status: 400 });
      expect(t.insert).not.toHaveBeenCalled();
    });

    it('turns the name index into 409 DUPLICATE and the exclusion into 409 YEAR_OVERLAP', async () => {
      const dup = build();
      dup.insert.mockRejectedValueOnce(
        Object.assign(new Error('dup'), {
          code: '23505',
          constraint: 'uq_academic_years_institution_name',
        }),
      );
      expect(await fail(dup.service.create(owner, body))).toMatchObject({ status: 409 });
      const overlap = build();
      overlap.insert.mockRejectedValueOnce(
        Object.assign(new Error('overlap'), {
          code: '23P01',
          constraint: 'ex_academic_years_no_overlap',
        }),
      );
      expect(await fail(overlap.service.create(owner, body))).toMatchObject({
        status: 409,
        code: 'YEAR_OVERLAP',
      });
    });
  });

  describe('update (AY-03)', () => {
    it('checks the version first', async () => {
      const t = build(year({ version: 3 }));
      expect(
        await fail(t.service.update(owner, 'year-1', { version: 2, name: 'x' })),
      ).toMatchObject({ status: 409 });
      expect(t.update).not.toHaveBeenCalled();
    });

    it('writes nothing when nothing changes', async () => {
      const t = build();
      const result = await t.service.update(owner, 'year-1', {
        version: 1,
        name: '2026-2027',
        startDate: '2026-06-01',
      });
      expect(result).toMatchObject({ version: 1 });
      expect(t.update).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('checks a changed end against the stored start', async () => {
      const t = build();
      expect(
        await fail(t.service.update(owner, 'year-1', { version: 1, endDate: '2026-05-31' })),
      ).toMatchObject({ status: 400 });
    });

    it('saves the changes and audits before and after', async () => {
      const t = build();
      await t.service.update(owner, 'year-1', { version: 1, name: 'Renamed' });
      expect(t.update.mock.calls[0]![2]).toMatchObject({ name: 'Renamed' });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'academic_year.updated',
        before: expect.objectContaining({ name: '2026-2027' }),
        after: expect.objectContaining({ name: 'Renamed' }),
      });
    });

    it('is 404 for an unknown or deactivated year', async () => {
      expect(
        await fail(build(null).service.update(owner, 'year-1', { version: 1, name: 'x' })),
      ).toMatchObject({ status: 404 });
      expect(
        await fail(build(year({ status: 0 })).service.update(owner, 'year-1', { version: 1 })),
      ).toMatchObject({ status: 404 });
    });
  });

  describe('makeCurrent (AY-04)', () => {
    it('swaps the current year and audits the one it replaced', async () => {
      const t = build();
      await t.service.makeCurrent(owner, 'year-1', 1);
      expect(t.update.mock.calls.map((call) => [call[1], call[2].is_current])).toEqual([
        ['year-0', false],
        ['year-1', true],
      ]);
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'academic_year.made_current',
        after: { is_current: true, previous_year_id: 'year-0' },
      });
    });

    it('makes current with none before, naming no previous year', async () => {
      const t = build();
      t.currentOf.mockResolvedValueOnce(undefined);
      await t.service.makeCurrent(owner, 'year-1', 1);
      expect(t.update).toHaveBeenCalledTimes(1);
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        after: { previous_year_id: null },
      });
    });

    it('writes nothing for the year already current, and checks the version', async () => {
      const t = build(year({ is_current: true }));
      expect(await t.service.makeCurrent(owner, 'year-1', 1)).toMatchObject({ isCurrent: true });
      expect(t.update).not.toHaveBeenCalled();
      expect(await fail(t.service.makeCurrent(owner, 'year-1', 9))).toMatchObject({ status: 409 });
    });
  });

  describe('deactivate (AY-05)', () => {
    it('deactivates a year that is not current, and audits it', async () => {
      const t = build();
      expect(await t.service.deactivate(owner, 'year-1')).toEqual({ id: 'year-1', status: 0 });
      expect(t.update.mock.calls[0]![2]).toMatchObject({ status: 0 });
      expect(t.record.mock.calls[0]![1]).toMatchObject({ action: 'academic_year.deactivated' });
    });

    it('refuses the current year with 409 CURRENT_YEAR_LOCKED, and an unknown one with 404', async () => {
      expect(
        await fail(build(year({ is_current: true })).service.deactivate(owner, 'year-1')),
      ).toMatchObject({ status: 409, code: 'CURRENT_YEAR_LOCKED' });
      expect(await fail(build(null).service.deactivate(owner, 'year-1'))).toMatchObject({
        status: 404,
      });
    });
  });
});
