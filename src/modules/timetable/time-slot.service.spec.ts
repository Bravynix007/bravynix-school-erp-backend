import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type {
  ChildContexts,
  InstitutionContext,
  ScopeService,
} from '../../platform/tenancy/index.js';
import type { AcademicYearDirectory } from '../academic-setup/index.js';
import type { CreateTimeSlotDto } from './time-slot.dto.js';
import type { TimeSlotRepository, TimeSlotRow } from './time-slot.repository.js';
import { TimeSlotService } from './time-slot.service.js';
import type { TimetableEntryRepository } from './timetable-entry.repository.js';

const principal = (roleCode: number) =>
  ({
    personId: 'person-1',
    sessionId: 'session-1',
    roleCode,
    societyId: 'society-1',
    clientType: 'mobile',
    viaSupportAccess: false,
  }) as Principal;
const admin = principal(3);
const teacher = principal(4);
const parent = principal(5);

const tenant: TenantContext = {
  personId: 'person-1',
  roleCode: 3,
  societyId: 'society-1',
  institutionIds: ['inst-1', 'inst-2'],
};
const narrowed: TenantContext = { ...tenant, institutionIds: ['inst-1'] };
const context: InstitutionContext = {
  institutionId: 'inst-1',
  societyId: 'society-1',
  tenant: narrowed,
};
const childContext: InstitutionContext = {
  institutionId: 'inst-1',
  societyId: 'society-1',
  tenant: { personId: 'parent-9', roleCode: 5, childIds: ['child-1'] },
};

const slot = (overrides: Partial<TimeSlotRow> = {}): TimeSlotRow => ({
  id: 'slot-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'person-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  period_no: 3,
  label: 'Period 3',
  start_time: '09:50:00',
  end_time: '10:30:00',
  is_break: false,
  ...overrides,
});

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) {
      return {
        status: error.status as number,
        code: error.code,
        fields: (error.options.errors ?? []).map((e) => e.field),
      };
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

const created: CreateTimeSlotDto = {
  institutionId: 'inst-1',
  periodNo: 3,
  startTime: '09:50',
  endTime: '10:30',
};

function build(current: TimeSlotRow | null = slot()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const active = vi.fn<TimeSlotRepository['active']>().mockResolvedValue([slot()]);
  const find = vi.fn<TimeSlotRepository['find']>().mockResolvedValue(current ?? undefined);
  const insert = vi
    .fn<TimeSlotRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(slot({ ...(values as Partial<TimeSlotRow>), id: 'slot-new' })),
    );
  const update = vi
    .fn<TimeSlotRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(slot({ ...current, ...(changes as Partial<TimeSlotRow>), id, version: 2 })),
    );
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant, societyId: 'society-1' } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const requireCurrentId = vi
    .fn<AcademicYearDirectory['requireCurrentId']>()
    .mockResolvedValue('year-1');
  const yearToRead = vi
    .fn<AcademicYearDirectory['yearToRead']>()
    .mockImplementation((_tx, _institutionId, yearId) => Promise.resolve(yearId ?? 'year-1'));
  const openYear = vi
    .fn<AcademicYearDirectory['openYear']>()
    .mockResolvedValue({ open: true, startDate: '2026-06-01', endDate: '2027-03-31' });
  const requireActive = vi.fn<AcademicYearDirectory['requireActive']>().mockResolvedValue();
  const childContextOf = vi.fn<ChildContexts['of']>().mockResolvedValue(childContext);
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const usesSlot = vi.fn<TimetableEntryRepository['usesSlot']>().mockResolvedValue(false);
  const service = new TimeSlotService(
    { transaction } as unknown as DatabaseService,
    { active, find, insert, update } as unknown as TimeSlotRepository,
    { usesSlot } as unknown as TimetableEntryRepository,
    { forPrincipal, requireInstitution } as unknown as ScopeService,
    { requireCurrentId, yearToRead, openYear, requireActive } as unknown as AcademicYearDirectory,
    { of: childContextOf } as unknown as ChildContexts,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
  );
  return {
    service,
    transaction,
    active,
    find,
    insert,
    update,
    forPrincipal,
    requireInstitution,
    requireCurrentId,
    yearToRead,
    openYear,
    requireActive,
    childContextOf,
    usesSlot,
    record,
  };
}

describe('TimeSlotService.list', () => {
  it('reads the current year of the Institution the caller names', async () => {
    const t = build();
    const result = await t.service.list(teacher, { institutionId: 'inst-1' });
    expect(t.requireInstitution).toHaveBeenCalledWith(teacher, 'inst-1');
    expect(t.transaction).toHaveBeenCalledWith(narrowed, expect.any(Function));
    expect(t.yearToRead).toHaveBeenCalledWith(expect.anything(), 'inst-1', undefined);
    expect(t.active).toHaveBeenCalledWith(expect.anything(), 'year-1');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ startTime: '09:50', endTime: '10:30' });
  });

  it('reads the year named, which must be one of the Institution', async () => {
    const t = build();
    await t.service.list(admin, { institutionId: 'inst-1', academicYearId: 'year-7' });
    expect(t.yearToRead).toHaveBeenCalledWith(expect.anything(), 'inst-1', 'year-7');
    expect(t.active).toHaveBeenCalledWith(expect.anything(), 'year-7');
    t.yearToRead.mockRejectedValueOnce(AppException.notFound());
    expect(
      await refusal(t.service.list(admin, { institutionId: 'inst-1', academicYearId: 'y' })),
    ).toMatchObject({ status: 404 });
  });

  it('is 400 REQUIRED on the Institution for a caller who names none, and refuses a child for them', async () => {
    const t = build();
    expect(await refusal(t.service.list(admin, {}))).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      fields: ['institutionId'],
    });
    expect(
      await refusal(t.service.list(admin, { institutionId: 'inst-1', studentId: 'c' })),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED', fields: ['studentId'] });
  });

  it('reads a parent’s child’s Institution in the child’s tenant, and refuses the Institution and the year', async () => {
    const t = build();
    await t.service.list(parent, { studentId: 'child-1' });
    expect(t.childContextOf).toHaveBeenCalledWith(parent, 'child-1');
    expect(t.transaction).toHaveBeenCalledWith(childContext.tenant, expect.any(Function));
    expect(t.yearToRead).toHaveBeenCalledWith(expect.anything(), 'inst-1', undefined);
    expect(await refusal(t.service.list(parent, {}))).toMatchObject({ fields: ['studentId'] });
    expect(
      await refusal(
        t.service.list(parent, { studentId: 'c', institutionId: 'i', academicYearId: 'y' }),
      ),
    ).toMatchObject({ status: 400, fields: ['institutionId', 'academicYearId'] });
  });
});

describe('TimeSlotService.create', () => {
  it('adds the period to the current year, and audits it with the Society and the Institution', async () => {
    const t = build();
    const result = await t.service.create(admin, { ...created, label: 'Period 3', isBreak: false });
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'inst-1');
    expect(t.transaction).toHaveBeenCalledWith(narrowed, expect.any(Function));
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        society_id: 'society-1',
        institution_id: 'inst-1',
        academic_year_id: 'year-1',
        period_no: 3,
        label: 'Period 3',
        start_time: '09:50',
        end_time: '10:30',
        is_break: false,
        created_by: 'person-1',
      }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'time_slot.created',
        societyId: 'society-1',
        institutionId: 'inst-1',
        entityType: 'time_slot',
      }),
    );
    expect(result).toMatchObject({ id: 'slot-new', startTime: '09:50' });
  });

  it('leaves the label empty and the period not a break when they are not sent', async () => {
    const t = build();
    await t.service.create(admin, created);
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ label: null, is_break: false }),
    );
  });

  it('adds to the year named when it is an active year of the Institution', async () => {
    const t = build();
    await t.service.create(admin, { ...created, academicYearId: 'year-2' });
    expect(t.requireActive).toHaveBeenCalledWith(
      expect.anything(),
      'year-2',
      'inst-1',
      'academicYearId',
    );
    expect(t.requireCurrentId).not.toHaveBeenCalled();
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ academic_year_id: 'year-2' }),
    );
  });

  it('is 400 on endTime when the end is not after the start, before anything is read', async () => {
    const t = build();
    expect(await refusal(t.service.create(admin, { ...created, endTime: '09:50' }))).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      fields: ['endTime'],
    });
    expect(t.transaction).not.toHaveBeenCalled();
  });

  it('turns a repeated number and an overlap into their conflicts', async () => {
    const t = build();
    t.insert.mockRejectedValueOnce({ code: '23505', constraint: 'uq_time_slots_year_period' });
    expect(await refusal(t.service.create(admin, created))).toMatchObject({
      status: 409,
      code: 'DUPLICATE',
      fields: ['periodNo'],
    });
    t.insert.mockRejectedValueOnce({ code: '23P01', constraint: 'ex_time_slots_no_overlap' });
    expect(await refusal(t.service.create(admin, created))).toMatchObject({
      status: 409,
      code: 'TIME_SLOT_OVERLAP',
    });
  });

  it('passes on the refusal of a year that is gone or has no current year', async () => {
    const t = build();
    t.requireCurrentId.mockRejectedValueOnce(AppException.businessRule('CURRENT_YEAR_REQUIRED'));
    expect(await refusal(t.service.create(admin, created))).toMatchObject({
      status: 422,
      code: 'CURRENT_YEAR_REQUIRED',
    });
    t.requireActive.mockRejectedValueOnce(AppException.referenceInactive('academicYearId'));
    expect(
      await refusal(t.service.create(admin, { ...created, academicYearId: 'year-2' })),
    ).toMatchObject({ status: 422, code: 'REFERENCE_INACTIVE', fields: ['academicYearId'] });
    expect(t.insert).not.toHaveBeenCalled();
  });
});

describe('TimeSlotService.update', () => {
  it('changes the label and the times, and audits the before and after', async () => {
    const t = build();
    const result = await t.service.update(admin, 'slot-1', {
      version: 1,
      label: null,
      startTime: '09:55',
    });
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'inst-1');
    expect(t.find).toHaveBeenLastCalledWith(expect.anything(), 'slot-1', true);
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'slot-1',
      expect.objectContaining({ label: null, start_time: '09:55', updated_by: 'person-1' }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'time_slot.updated',
        before: expect.objectContaining({ start_time: '09:50', label: 'Period 3' }),
        after: expect.objectContaining({ start_time: '09:55', label: null }),
      }),
    );
    expect(result.version).toBe(2);
  });

  it('writes nothing for a request that changes nothing, the times compared as written', async () => {
    const t = build();
    const result = await t.service.update(admin, 'slot-1', {
      version: 1,
      label: 'Period 3',
      startTime: '09:50',
      endTime: '10:30',
    });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(result.version).toBe(1);
  });

  it('checks the order of the times the period would have, with the one that stays', async () => {
    const t = build();
    expect(
      await refusal(t.service.update(admin, 'slot-1', { version: 1, startTime: '10:30' })),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED', fields: ['endTime'] });
    expect(t.update).not.toHaveBeenCalled();
  });

  it('is 409 VERSION_CONFLICT for an old version', async () => {
    const t = build(slot({ version: 3 }));
    expect(
      await refusal(t.service.update(admin, 'slot-1', { version: 1, label: 'x' })),
    ).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });

  it('is 404 for a period that is gone, deactivated, or outside the caller’s reach', async () => {
    const t = build(null);
    expect(await refusal(t.service.update(admin, 'slot-1', { version: 1 }))).toMatchObject({
      status: 404,
    });
    const gone = build(slot({ status: 0 }));
    expect(await refusal(gone.service.update(admin, 'slot-1', { version: 1 }))).toMatchObject({
      status: 404,
    });
    const outside = build();
    outside.requireInstitution.mockRejectedValue(AppException.notFound());
    expect(await refusal(outside.service.update(admin, 'slot-1', { version: 1 }))).toMatchObject({
      status: 404,
    });
  });

  it('turns an overlap into TIME_SLOT_OVERLAP', async () => {
    const t = build();
    t.update.mockRejectedValueOnce({ code: '23P01', constraint: 'ex_time_slots_no_overlap' });
    expect(
      await refusal(t.service.update(admin, 'slot-1', { version: 1, endTime: '11:00' })),
    ).toMatchObject({ status: 409, code: 'TIME_SLOT_OVERLAP' });
  });
});

describe('TimeSlotService.deactivate', () => {
  it('deactivates an active period and audits it', async () => {
    const t = build();
    expect(await t.service.deactivate(admin, 'slot-1')).toEqual({ id: 'slot-1', status: 0 });
    expect(t.find).toHaveBeenLastCalledWith(expect.anything(), 'slot-1', true);
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'slot-1',
      expect.objectContaining({ status: 0, updated_by: 'person-1' }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'time_slot.deactivated', entityId: 'slot-1' }),
    );
  });

  it('is 409 TIME_SLOT_IN_USE while an active timetable entry sits in the period, and changes nothing', async () => {
    const t = build();
    t.usesSlot.mockResolvedValue(true);
    expect(await refusal(t.service.deactivate(admin, 'slot-1'))).toMatchObject({
      status: 409,
      code: 'TIME_SLOT_IN_USE',
    });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
  });

  it('is 404 for a period that is gone or already deactivated', async () => {
    expect(await refusal(build(null).service.deactivate(admin, 'slot-1'))).toMatchObject({
      status: 404,
    });
    expect(
      await refusal(build(slot({ status: 0 })).service.deactivate(admin, 'slot-1')),
    ).toMatchObject({ status: 404 });
  });
});
