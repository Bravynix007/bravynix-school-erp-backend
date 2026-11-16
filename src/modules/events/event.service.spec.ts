import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { MasterReferences } from '../../platform/masters/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';
import type { AcademicYearDirectory } from '../academic-setup/index.js';
import type { CreateEventDto, UpdateEventDto } from './event.dto.js';
import type { EventRepository, EventRow } from './event.repository.js';
import { EventService } from './event.service.js';

const principal = (roleCode: number) =>
  ({
    personId: 'person-1',
    sessionId: 'session-1',
    roleCode,
    societyId: 'society-1',
    clientType: 'mobile',
    viaSupportAccess: false,
  }) as Principal;
const owner = principal(2);
const admin = principal(3);
const teacher = principal(4);

const tenant: TenantContext = {
  personId: 'person-1',
  roleCode: 2,
  societyId: 'society-1',
  institutionIds: ['inst-1', 'inst-2'],
};
const narrowed: TenantContext = { ...tenant, institutionIds: ['inst-2'] };
const context: InstitutionContext = {
  institutionId: 'inst-2',
  societyId: 'society-1',
  tenant: narrowed,
};

const event = (overrides: Partial<EventRow> = {}): EventRow => ({
  id: 'event-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'person-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  scope: 2,
  institution_id: 'inst-1',
  title: 'Annual Day',
  description: null,
  venue: null,
  start_date: '2026-12-22',
  end_date: '2026-12-24',
  duration_label: '3 Days',
  audience: 1,
  preset_image_code: null,
  is_holiday: false,
  holiday_type: null,
  holiday_for_students: false,
  holiday_for_staff: false,
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

const created: CreateEventDto = {
  title: 'Annual Day',
  startDate: '2026-12-22',
  endDate: '2026-12-24',
  durationLabel: '3 Days',
  scope: 2,
  institutionId: 'inst-1',
};

function build(current: EventRow | null = event(), currentClasses: string[] = []) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const list = vi.fn<EventRepository['list']>().mockResolvedValue([event()]);
  const find = vi.fn<EventRepository['find']>().mockResolvedValue(current ?? undefined);
  const insert = vi
    .fn<EventRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(event({ ...(values as Partial<EventRow>), id: 'event-new' })),
    );
  const update = vi
    .fn<EventRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(event({ ...current, ...(changes as Partial<EventRow>), id, version: 2 })),
    );
  const classesOf = vi
    .fn<EventRepository['classesOf']>()
    .mockResolvedValue(current ? new Map([[current.id, currentClasses]]) : new Map());
  const replaceClasses = vi.fn<EventRepository['replaceClasses']>().mockResolvedValue();
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant, societyId: 'society-1' } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const requireAllShown = vi.fn<MasterReferences['requireAllShown']>().mockResolvedValue();
  const openYear = vi
    .fn<AcademicYearDirectory['openYear']>()
    .mockResolvedValue({ startDate: '2026-06-01', endDate: '2027-03-31' } as Awaited<
      ReturnType<AcademicYearDirectory['openYear']>
    >);
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new EventService(
    { transaction } as unknown as DatabaseService,
    { list, find, insert, update, classesOf, replaceClasses } as unknown as EventRepository,
    { forPrincipal, requireInstitution } as unknown as ScopeService,
    { requireAllShown } as unknown as MasterReferences,
    { openYear } as unknown as AcademicYearDirectory,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
  );
  return {
    service,
    transaction,
    list,
    find,
    insert,
    update,
    classesOf,
    replaceClasses,
    forPrincipal,
    requireInstitution,
    requireAllShown,
    openYear,
    record,
  };
}

const edit = (fields: Partial<UpdateEventDto> = {}): UpdateEventDto => ({
  version: 1,
  ...fields,
});

describe('EventService.list', () => {
  it('reads the Society’s tenant for the audiences of the role, and by default holidays and plain events', async () => {
    const { service, list, transaction } = build();
    const result = await service.list(teacher, { from: '2026-12-01', to: '2026-12-31' });
    expect(transaction).toHaveBeenCalledWith(tenant, expect.any(Function));
    expect(list).toHaveBeenCalledWith(expect.anything(), {
      from: '2026-12-01',
      to: '2026-12-31',
      holidaysOnly: false,
      audiences: [1, 3],
    });
    expect(result.data).toHaveLength(1);
  });

  it('narrows to one Institution the caller reaches, and keeps holidays only when asked', async () => {
    const { service, list, requireInstitution, transaction } = build();
    await service.list(admin, {
      from: '2026-12-01',
      to: '2026-12-31',
      institutionId: 'inst-2',
      holidays: true,
    });
    expect(requireInstitution).toHaveBeenCalledWith(admin, 'inst-2');
    expect(transaction).toHaveBeenCalledWith(narrowed, expect.any(Function));
    expect(list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ holidaysOnly: true }),
    );
  });

  it('is 403 for a caller with no Society', async () => {
    const { service, forPrincipal } = build();
    forPrincipal.mockResolvedValue({ societyId: null } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
    expect(
      await refusal(service.list(owner, { from: '2026-12-01', to: '2026-12-31' })),
    ).toMatchObject({ status: 403 });
  });

  it('takes the dates of an academic year, which needs its Institution and no dates, and is 404 when it is not open', async () => {
    const { service, list, openYear } = build();
    await service.list(owner, { academicYearId: 'year-1', institutionId: 'inst-2' });
    expect(openYear).toHaveBeenCalledWith(expect.anything(), 'year-1', 'inst-2');
    expect(list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: '2026-06-01', to: '2027-03-31' }),
    );
    expect(await refusal(service.list(owner, { academicYearId: 'year-1' }))).toMatchObject({
      fields: ['institutionId'],
    });
    expect(
      await refusal(
        service.list(owner, {
          academicYearId: 'year-1',
          institutionId: 'inst-2',
          from: '2026-12-01',
        }),
      ),
    ).toMatchObject({ fields: ['from'] });
    openYear.mockResolvedValue(undefined);
    expect(
      await refusal(service.list(owner, { academicYearId: 'year-1', institutionId: 'inst-2' })),
    ).toMatchObject({ status: 404 });
  });

  it('asks for both dates, and a span of at most 366 days', async () => {
    const { service } = build();
    expect(await refusal(service.list(owner, {}))).toMatchObject({ fields: ['from', 'to'] });
    expect(await refusal(service.list(owner, { to: '2026-12-31' }))).toMatchObject({
      fields: ['from'],
    });
    expect(
      await refusal(service.list(owner, { from: '2026-01-01', to: '2027-01-02' })),
    ).toMatchObject({
      status: 400,
      code: 'RANGE_TOO_LARGE',
    });
  });
});

describe('EventService.get', () => {
  it('shows an active event for an audience of the role, and is 404 for another, a deactivated one or none', async () => {
    expect((await build(event({ audience: 3 })).service.get(teacher, 'event-1')).id).toBe(
      'event-1',
    );
    expect(
      await refusal(build(event({ audience: 2 })).service.get(teacher, 'event-1')),
    ).toMatchObject({ status: 404 });
    expect(await refusal(build(event({ status: 0 })).service.get(owner, 'event-1'))).toMatchObject({
      status: 404,
    });
    expect(await refusal(build(null).service.get(owner, 'event-1'))).toMatchObject({
      status: 404,
    });
  });
});

describe('EventService.create', () => {
  it('writes the event with its author, the classes of a holiday and one audit entry', async () => {
    const { service, insert, replaceClasses, requireAllShown, record, transaction } = build();
    const result = await service.create(owner, {
      ...created,
      isHoliday: true,
      holidayType: 3,
      holidayForStudents: true,
      holidayPredefinedClassIds: ['c2', 'c1'],
    });
    expect(transaction).toHaveBeenCalledWith(narrowed, expect.any(Function));
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        society_id: 'society-1',
        scope: 2,
        institution_id: 'inst-1',
        audience: 1,
        is_holiday: true,
        holiday_type: 3,
        created_by: 'person-1',
        updated_by: 'person-1',
      }),
    );
    expect(requireAllShown).toHaveBeenCalledWith(expect.anything(), 'predefined_classes', [
      { id: 'c2', field: 'holidayPredefinedClassIds[0]' },
      { id: 'c1', field: 'holidayPredefinedClassIds[1]' },
    ]);
    expect(replaceClasses).toHaveBeenCalledWith(expect.anything(), 'event-new', 'society-1', [
      'c2',
      'c1',
    ]);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'event.created',
        institutionId: 'inst-1',
        entityType: 'event',
      }),
    );
    expect(result.holidayPredefinedClassIds).toEqual(['c1', 'c2']);
  });

  it('makes a Society event in the Society’s tenant, for the Owner only', async () => {
    const { service, insert, requireInstitution, forPrincipal } = build();
    await service.create(owner, { ...created, scope: 1, institutionId: undefined });
    expect(requireInstitution).not.toHaveBeenCalled();
    expect(forPrincipal).toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 1, institution_id: null }),
    );
    const refused = build();
    expect(
      await refusal(
        refused.service.create(admin, { ...created, scope: 1, institutionId: undefined }),
      ),
    ).toMatchObject({ status: 403, code: 'SCOPE_NOT_ALLOWED' });
    expect(refused.insert).not.toHaveBeenCalled();
  });

  it('checks the fields before anything is read or written', async () => {
    const { service, requireInstitution, insert } = build();
    expect(
      await refusal(service.create(owner, { ...created, endDate: '2026-12-01' })),
    ).toMatchObject({ fields: ['endDate'] });
    expect(
      await refusal(service.create(owner, { ...created, institutionId: undefined })),
    ).toMatchObject({ fields: ['institutionId'] });
    expect(requireInstitution).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('does not look up classes for an event with none', async () => {
    const { service, requireAllShown, replaceClasses } = build();
    await service.create(owner, created);
    expect(requireAllShown).not.toHaveBeenCalled();
    expect(replaceClasses).toHaveBeenCalledWith(expect.anything(), 'event-new', 'society-1', []);
  });
});

describe('EventService.update', () => {
  it('changes the fields sent, stamps the editor and writes one audit entry with before and after', async () => {
    const { service, update, record } = build();
    const result = await service.update(owner, 'event-1', edit({ title: 'Annual Day 2026' }));
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      'event-1',
      expect.objectContaining({ title: 'Annual Day 2026', updated_by: 'person-1' }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'event.updated',
        institutionId: 'inst-1',
        before: expect.objectContaining({ title: 'Annual Day' }),
        after: expect.objectContaining({ title: 'Annual Day 2026' }),
      }),
    );
    expect(result.version).toBe(2);
  });

  it('writes nothing for a request that changes nothing', async () => {
    const { service, update, record, replaceClasses } = build(event({ title: 'Annual Day' }));
    const result = await service.update(
      owner,
      'event-1',
      edit({ title: 'Annual Day', venue: null }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(replaceClasses).not.toHaveBeenCalled();
    expect(result.version).toBe(1);
  });

  it('answers a stale version before it asks who may change the event', async () => {
    const { service } = build(event({ scope: 1, institution_id: null, version: 3 }));
    expect(await refusal(service.update(admin, 'event-1', edit({ title: 'x' })))).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
    });
  });

  it('lets an Admin change an Institution event, and refuses the Society’s without locking it', async () => {
    const mine = build();
    await mine.service.update(admin, 'event-1', edit({ title: 'x' }));
    expect(mine.find.mock.calls.map((call) => call[2] ?? false)).toEqual([false, true]);
    const society = build(event({ scope: 1, institution_id: null }));
    expect(
      await refusal(society.service.update(admin, 'event-1', edit({ title: 'x' }))),
    ).toMatchObject({
      status: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
    expect(society.find.mock.calls.map((call) => call[2] ?? false)).toEqual([false]);
    expect(society.update).not.toHaveBeenCalled();
  });

  it('checks who may change the event again once it is locked, as the scope may have been moved meanwhile', async () => {
    const { service, find, update } = build();
    find
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event({ scope: 1, institution_id: null }));
    expect(await refusal(service.update(admin, 'event-1', edit({ title: 'x' })))).toMatchObject({
      status: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('is 404 for an event that is gone or deactivated', async () => {
    expect(await refusal(build(null).service.update(owner, 'event-1', edit()))).toMatchObject({
      status: 404,
    });
    expect(
      await refusal(build(event({ status: 0 })).service.update(owner, 'event-1', edit())),
    ).toMatchObject({ status: 404 });
  });

  it('checks the event as it will be: dates against the stored ones, holiday fields against the stored holiday', async () => {
    const { service, update } = build(event({ start_date: '2026-12-22', end_date: '2026-12-24' }));
    expect(
      await refusal(service.update(owner, 'event-1', edit({ endDate: '2026-12-21' }))),
    ).toMatchObject({ fields: ['endDate'] });
    expect(
      await refusal(service.update(owner, 'event-1', edit({ isHoliday: true }))),
    ).toMatchObject({
      fields: ['holidayType', 'holidayForStudents'],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('replaces the classes only when the set changed, and looks up only those that are new', async () => {
    const { service, replaceClasses, requireAllShown } = build(
      event({ is_holiday: true, holiday_type: 1, holiday_for_students: true }),
      ['c1'],
    );
    await service.update(owner, 'event-1', edit({ holidayPredefinedClassIds: ['c1', 'c2'] }));
    expect(requireAllShown).toHaveBeenCalledWith(expect.anything(), 'predefined_classes', [
      { id: 'c2', field: 'holidayPredefinedClassIds[1]' },
    ]);
    expect(replaceClasses).toHaveBeenCalledWith(expect.anything(), 'event-1', 'society-1', [
      'c1',
      'c2',
    ]);
  });

  it('clears the holiday fields and classes when an event stops being a holiday', async () => {
    const { service, update, replaceClasses } = build(
      event({
        is_holiday: true,
        holiday_type: 2,
        holiday_for_students: true,
        holiday_for_staff: true,
      }),
      ['c1'],
    );
    await service.update(owner, 'event-1', edit({ isHoliday: false }));
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      'event-1',
      expect.objectContaining({
        is_holiday: false,
        holiday_type: null,
        holiday_for_students: false,
        holiday_for_staff: false,
      }),
    );
    expect(replaceClasses).toHaveBeenCalledWith(expect.anything(), 'event-1', 'society-1', []);
  });
});

describe('EventService.deactivate', () => {
  it('deactivates the event, stamps the editor and audits before and after', async () => {
    const { service, update, record } = build();
    expect(await service.deactivate(owner, 'event-1')).toEqual({ id: 'event-1', status: 0 });
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      'event-1',
      expect.objectContaining({ status: 0, updated_by: 'person-1' }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'event.deactivated' }),
    );
  });

  it('is refused to an Admin for a Society event, and 404 when already deactivated', async () => {
    const society = build(event({ scope: 1, institution_id: null }));
    expect(await refusal(society.service.deactivate(admin, 'event-1'))).toMatchObject({
      status: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
    expect(
      await refusal(build(event({ status: 0 })).service.deactivate(owner, 'event-1')),
    ).toMatchObject({ status: 404 });
  });
});

describe('EventService.changeScope', () => {
  it('moves an Institution event to the Society and writes one audit entry', async () => {
    const { service, update, record, requireInstitution } = build();
    await service.changeScope(owner, 'event-1', { version: 1, scope: 1 });
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      'event-1',
      expect.objectContaining({ scope: 1, institution_id: null }),
    );
    expect(requireInstitution).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'event.scope_changed' }),
    );
  });

  it('moves a Society event to an Institution the Owner reaches', async () => {
    const { service, update, requireInstitution } = build(
      event({ scope: 1, institution_id: null }),
    );
    await service.changeScope(owner, 'event-1', { version: 1, scope: 2, institutionId: 'inst-2' });
    expect(requireInstitution).toHaveBeenCalledWith(owner, 'inst-2');
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      'event-1',
      expect.objectContaining({ scope: 2, institution_id: 'inst-2' }),
    );
  });

  it('writes nothing when the event is there already, and checks the pair and the version first', async () => {
    const same = build();
    await same.service.changeScope(owner, 'event-1', {
      version: 1,
      scope: 2,
      institutionId: 'inst-1',
    });
    expect(same.update).not.toHaveBeenCalled();
    expect(same.record).not.toHaveBeenCalled();
    expect(
      await refusal(same.service.changeScope(owner, 'event-1', { version: 1, scope: 2 })),
    ).toMatchObject({ fields: ['institutionId'] });
    expect(
      await refusal(same.service.changeScope(owner, 'event-1', { version: 7, scope: 1 })),
    ).toMatchObject({ status: 409 });
  });
});
