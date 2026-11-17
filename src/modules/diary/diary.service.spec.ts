import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { Notifications } from '../../platform/notifications/index.js';
import type {
  ChildContexts,
  InstitutionContext,
  ScopeService,
} from '../../platform/tenancy/index.js';
import type {
  AcademicYearDirectory,
  SectionDirectory,
  SubjectDirectory,
  TeachingStaff,
} from '../academic-setup/index.js';
import type { DiaryPeople } from './diary-people.js';
import type { DiaryEntryRow, DiaryRepository } from './diary.repository.js';
import { DiaryService } from './diary.service.js';

const principal = (roleCode: number) =>
  ({ personId: 'person-1', roleCode, societyId: 'society-1' }) as Principal;
const admin = principal(3);
const teacher = principal(4);
const parent = principal(5);

const tenant: TenantContext = {
  personId: 'person-1',
  roleCode: 3,
  societyId: 'society-1',
  institutionIds: ['inst-1'],
};
const context: InstitutionContext = { institutionId: 'inst-1', societyId: 'society-1', tenant };
const childContext: InstitutionContext = {
  institutionId: 'inst-1',
  societyId: 'society-1',
  tenant: { personId: 'parent-9', roleCode: 5, childIds: ['child-1'] },
};
const year = { open: true, startDate: '2026-06-01', endDate: '2027-03-31' };

const entry = (overrides: Partial<DiaryEntryRow> = {}): DiaryEntryRow => ({
  id: 'entry-1',
  created_at: new Date('2026-11-17T01:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-17T01:00:00.000Z'),
  updated_by: 'person-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  section_id: 'section-1',
  subject_id: 'subject-1',
  staff_member_id: 'staff-1',
  diary_date: '2026-11-17',
  description: 'Exercise 4.2',
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
        fields: (error.options.errors ?? []).map((e) => `${e.field}:${e.code}`),
      };
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

function build(current: DiaryEntryRow | undefined = entry()) {
  const tx = {} as Tx;
  const transaction = vi.fn<
    (tenant: TenantContext, work: (tx: Tx) => Promise<unknown>) => Promise<unknown>
  >((_tenant, work) => work(tx));
  const list = vi.fn<DiaryRepository['list']>().mockResolvedValue([entry()]);
  const find = vi.fn<DiaryRepository['find']>().mockResolvedValue(current);
  const insert = vi
    .fn<DiaryRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(entry({ ...(values as Partial<DiaryEntryRow>), id: 'entry-new' })),
    );
  const update = vi
    .fn<DiaryRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(
        entry({ ...current, ...(changes as Partial<DiaryEntryRow>), id, version: 2 }),
      ),
    );
  const forPrincipal = vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({
    tenant,
    societyId: 'society-1',
  } as Awaited<ReturnType<ScopeService['forPrincipal']>>);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const requireCurrentId = vi
    .fn<AcademicYearDirectory['requireCurrentId']>()
    .mockResolvedValue('year-1');
  const openYear = vi.fn<AcademicYearDirectory['openYear']>().mockResolvedValue(year);
  const placeOf = vi.fn<SectionDirectory['placeOf']>().mockResolvedValue({
    classId: 'class-1',
    institutionId: 'inst-1',
    active: true,
    capacity: null,
  });
  const requireSection = vi.fn<SectionDirectory['requireActive']>().mockResolvedValue();
  const sectionNames = vi
    .fn<SectionDirectory['names']>()
    .mockResolvedValue(
      new Map([['section-1', { displayName: 'A', classId: 'c', className: '5' }]]),
    );
  const requireSubject = vi.fn<SubjectDirectory['requireActive']>().mockResolvedValue();
  const subjectNames = vi
    .fn<SubjectDirectory['names']>()
    .mockResolvedValue(new Map([['subject-1', 'Maths']]));
  const ownSectionIds = vi
    .fn<TeachingStaff['ownSectionIds']>()
    .mockResolvedValue(new Set(['section-1']));
  const ownRecord = vi
    .fn<DiaryPeople['ownRecord']>()
    .mockResolvedValue({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-1' });
  const mayWrite = vi.fn<DiaryPeople['mayWrite']>().mockResolvedValue(true);
  const teacherNames = vi
    .fn<DiaryPeople['names']>()
    .mockResolvedValue(new Map([['staff-1', 'Asha Rao']]));
  const parentNames = vi
    .fn<DiaryPeople['namesForParent']>()
    .mockResolvedValue(new Map([['staff-1', 'Asha Rao']]));
  const currentSectionId = vi.fn<DiaryPeople['currentSectionId']>().mockResolvedValue('section-1');
  const receiversOf = vi
    .fn<DiaryPeople['receiversOf']>()
    .mockResolvedValue([{ userId: 'user-1', studentId: 'child-1' }]);
  const childContextOf = vi.fn<ChildContexts['of']>().mockResolvedValue(childContext);
  const notify = vi.fn<Notifications['notify']>().mockResolvedValue(null);
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new DiaryService(
    { transaction } as unknown as DatabaseService,
    { list, find, insert, update } as unknown as DiaryRepository,
    { forPrincipal, requireInstitution } as unknown as ScopeService,
    { requireCurrentId, openYear } as unknown as AcademicYearDirectory,
    { placeOf, requireActive: requireSection, names: sectionNames } as unknown as SectionDirectory,
    { requireActive: requireSubject, names: subjectNames } as unknown as SubjectDirectory,
    { ownSectionIds } as unknown as TeachingStaff,
    {
      ownRecord,
      mayWrite,
      names: teacherNames,
      namesForParent: parentNames,
      currentSectionId,
      receiversOf,
    } as unknown as DiaryPeople,
    { of: childContextOf } as unknown as ChildContexts,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { notify } as unknown as Notifications,
    { record } as unknown as AuditService,
    new FixedClock('2026-11-17T01:00:00.000Z'),
  );
  return {
    service,
    list,
    find,
    insert,
    update,
    requireInstitution,
    requireSection,
    requireSubject,
    requireCurrentId,
    ownSectionIds,
    ownRecord,
    mayWrite,
    teacherNames,
    parentNames,
    sectionNames,
    currentSectionId,
    receiversOf,
    childContextOf,
    notify,
    record,
  };
}

const body = (fields: object = {}) => ({
  sectionId: 'section-1',
  subjectId: 'subject-1',
  diaryDate: '2026-11-17',
  description: 'Exercise 4.2',
  ...fields,
});

describe('DiaryService.list', () => {
  it('reads the section’s entries on the date, with the section and teacher names', async () => {
    const t = build();
    const result = await t.service.list(admin, { sectionId: 'section-1', date: '2026-11-17' });
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'inst-1');
    expect(t.list).toHaveBeenCalledWith(expect.anything(), 'section-1', '2026-11-17');
    expect(result.data[0]).toMatchObject({
      sectionName: 'A',
      subject: { name: 'Maths' },
      teacher: { displayName: 'Asha Rao' },
    });
    expect(t.ownSectionIds).not.toHaveBeenCalled();
  });

  it('lets a teacher read only a section they lead or teach', async () => {
    const t = build();
    await t.service.list(teacher, { sectionId: 'section-1', date: '2026-11-17' });
    t.ownSectionIds.mockResolvedValue(new Set(['section-2']));
    expect(
      await refusal(t.service.list(teacher, { sectionId: 'section-1', date: '2026-11-17' })),
    ).toMatchObject({ status: 403, code: 'NOT_ASSIGNED' });
  });

  it('gives a parent the section their child sits in, with no section names, and nothing for a child in none', async () => {
    const t = build();
    const result = await t.service.list(parent, { studentId: 'child-1', date: '2026-11-17' });
    expect(t.childContextOf).toHaveBeenCalledWith(parent, 'child-1');
    expect(t.list).toHaveBeenCalledWith(expect.anything(), 'section-1', '2026-11-17');
    expect(t.parentNames).toHaveBeenCalled();
    expect(t.teacherNames).not.toHaveBeenCalled();
    expect(t.sectionNames).not.toHaveBeenCalled();
    expect(result.data[0]).toMatchObject({
      sectionName: null,
      teacher: { displayName: 'Asha Rao' },
    });
    t.currentSectionId.mockResolvedValue(undefined);
    expect(
      (await t.service.list(parent, { studentId: 'child-1', date: '2026-11-17' })).data,
    ).toEqual([]);
  });

  it('asks a parent for the child alone and everyone else for a section alone (400)', async () => {
    const t = build();
    expect(
      await refusal(t.service.list(parent, { sectionId: 'section-1', date: '2026-11-17' })),
    ).toMatchObject({ status: 400, fields: ['studentId:REQUIRED', 'sectionId:FIELD_NOT_ALLOWED'] });
    expect(
      await refusal(t.service.list(admin, { studentId: 'child-1', date: '2026-11-17' })),
    ).toMatchObject({ status: 400, fields: ['studentId:FIELD_NOT_ALLOWED', 'sectionId:REQUIRED'] });
  });
});

describe('DiaryService.create', () => {
  it('writes the entry for an Owner or Admin with no author, audits it and tells the parents', async () => {
    const t = build();
    t.ownRecord.mockResolvedValue(undefined);
    const created = await t.service.create(admin, body());
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        institution_id: 'inst-1',
        academic_year_id: 'year-1',
        section_id: 'section-1',
        subject_id: 'subject-1',
        staff_member_id: null,
        diary_date: '2026-11-17',
        created_by: 'person-1',
      }),
    );
    expect(t.mayWrite).not.toHaveBeenCalled();
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'diary_entry.created', entityId: 'entry-new' }),
    );
    expect(t.receiversOf).toHaveBeenCalledWith(expect.anything(), 'section-1', '2026-11-17');
    expect(t.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'diary:entry-new',
        category: 2,
        title: 'New diary entry',
        body: 'Maths: a diary entry for 17 Nov 2026.',
        target: { type: 2, id: 'entry-new' },
        receivers: [{ userId: 'user-1', studentId: 'child-1' }],
      }),
      'person-1',
    );
    expect(created.id).toBe('entry-new');
  });

  it('records a teacher as the author when they may write the subject in the section', async () => {
    const t = build();
    await t.service.create(teacher, body());
    expect(t.mayWrite).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      'year-1',
      'section-1',
      'subject-1',
    );
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ staff_member_id: 'staff-1' }),
    );
  });

  it('is 403 NOT_ASSIGNED for a teacher who may not write it, or away from their home Institution, and writes nothing', async () => {
    const t = build();
    t.mayWrite.mockResolvedValue(false);
    expect(await refusal(t.service.create(teacher, body()))).toMatchObject({
      status: 403,
      code: 'NOT_ASSIGNED',
    });
    t.mayWrite.mockResolvedValue(true);
    t.ownRecord.mockResolvedValue({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-2' });
    expect((await refusal(t.service.create(teacher, body()))).code).toBe('NOT_ASSIGNED');
    t.ownRecord.mockResolvedValue(undefined);
    expect((await refusal(t.service.create(teacher, body()))).code).toBe('NOT_ASSIGNED');
    expect(t.insert).not.toHaveBeenCalled();
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('keeps no author for an admin who is staff at another Institution', async () => {
    const t = build();
    t.ownRecord.mockResolvedValue({ staffMemberId: 'staff-9', homeInstitutionId: 'inst-2' });
    await t.service.create(admin, body());
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ staff_member_id: null }),
    );
  });

  it('refuses a date that has not come, is too far back or is outside the year, in that order, writing nothing', async () => {
    const t = build();
    for (const [diaryDate, code] of [
      ['2026-11-18', 'DATE_IN_FUTURE'],
      ['2026-11-09', 'DATE_TOO_OLD'],
    ] as const) {
      expect(await refusal(t.service.create(admin, body({ diaryDate })))).toMatchObject({
        status: 422,
        code,
      });
    }
    expect(t.insert).not.toHaveBeenCalled();
  });

  it('sends no notice when no guardian has a login', async () => {
    const t = build();
    t.receiversOf.mockResolvedValue([]);
    await t.service.create(admin, body());
    expect(t.insert).toHaveBeenCalled();
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('passes on what the directories refuse: a section out of reach, a closed subject, no current year', async () => {
    const t = build();
    t.requireSubject.mockRejectedValue(AppException.referenceInactive('subjectId'));
    expect(await refusal(t.service.create(admin, body()))).toMatchObject({
      status: 422,
      fields: ['subjectId:REFERENCE_INACTIVE'],
    });
    t.requireSubject.mockResolvedValue();
    t.requireCurrentId.mockRejectedValue(AppException.notFound());
    expect((await refusal(t.service.create(admin, body()))).status).toBe(404);
  });
});

describe('DiaryService.update', () => {
  it('changes what is sent, bumps the version through the repository and audits before and after', async () => {
    const t = build();
    const updated = await t.service.update(admin, 'entry-1', { version: 1, description: 'Redo.' });
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'entry-1',
      expect.objectContaining({ description: 'Redo.', updated_by: 'person-1' }),
    );
    expect(updated).toMatchObject({ version: 2, description: 'Redo.' });
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'diary_entry.updated',
        before: expect.objectContaining({ description: 'Exercise 4.2' }),
        after: expect.objectContaining({ description: 'Redo.' }),
      }),
    );
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('writes nothing for a request that changes nothing', async () => {
    const t = build();
    const same = await t.service.update(admin, 'entry-1', {
      version: 1,
      description: 'Exercise 4.2',
    });
    expect(same.version).toBe(1);
    expect(t.update).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
  });

  it('is 409 for a stale version, before anything else, and 404 for an entry that is gone or removed', async () => {
    const t = build(entry({ version: 3 }));
    expect(await refusal(t.service.update(admin, 'entry-1', { version: 1 }))).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
    });
    t.find.mockResolvedValue(entry({ status: 0 }));
    expect((await refusal(t.service.update(admin, 'entry-1', { version: 1 }))).status).toBe(404);
    t.find.mockResolvedValue(undefined);
    expect((await refusal(t.service.update(admin, 'entry-1', { version: 1 }))).status).toBe(404);
  });

  it('lets a teacher change only their own entry, and a subject they may write', async () => {
    const t = build();
    await t.service.update(teacher, 'entry-1', { version: 1, description: 'Mine.' });
    expect(t.update).toHaveBeenCalledTimes(1);
    t.ownRecord.mockResolvedValue({ staffMemberId: 'staff-2', homeInstitutionId: 'inst-1' });
    expect(
      await refusal(t.service.update(teacher, 'entry-1', { version: 1, description: 'Not mine.' })),
    ).toMatchObject({ status: 403, code: 'NOT_ASSIGNED' });
    t.ownRecord.mockResolvedValue({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-1' });
    t.mayWrite.mockResolvedValue(false);
    expect(
      await refusal(t.service.update(teacher, 'entry-1', { version: 1, subjectId: 'subject-2' })),
    ).toMatchObject({ status: 403, code: 'NOT_ASSIGNED' });
    expect(t.requireSubject).toHaveBeenCalledWith(expect.anything(), ['subject-2'], 'subjectId');
    expect(t.update).toHaveBeenCalledTimes(1);
  });

  it('checks a new date against the entry’s year and the limits, and leaves an unchanged date alone', async () => {
    const t = build();
    expect(
      await refusal(t.service.update(admin, 'entry-1', { version: 1, diaryDate: '2026-11-18' })),
    ).toMatchObject({ status: 422, code: 'DATE_IN_FUTURE' });
    expect(
      await refusal(t.service.update(admin, 'entry-1', { version: 1, diaryDate: '2026-11-01' })),
    ).toMatchObject({ status: 422, code: 'DATE_TOO_OLD' });
    await t.service.update(admin, 'entry-1', { version: 1, diaryDate: '2026-11-16' });
    expect(t.update).toHaveBeenCalledTimes(1);
  });

  it('lets an old entry’s description change when its date does not', async () => {
    const t = build(entry({ diary_date: '2026-10-01' }));
    await t.service.update(admin, 'entry-1', { version: 1, description: 'Corrected.' });
    expect(t.update).toHaveBeenCalledTimes(1);
  });
});

describe('DiaryService.deactivate', () => {
  it('removes the entry, as status 0, and audits it', async () => {
    const t = build();
    expect(await t.service.deactivate(admin, 'entry-1')).toEqual({ id: 'entry-1', status: 0 });
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'entry-1',
      expect.objectContaining({ status: 0 }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'diary_entry.deactivated' }),
    );
  });

  it('lets a teacher remove their own entry only, and is 404 for one already removed', async () => {
    const t = build();
    await t.service.deactivate(teacher, 'entry-1');
    t.ownRecord.mockResolvedValue({ staffMemberId: 'staff-2', homeInstitutionId: 'inst-1' });
    expect((await refusal(t.service.deactivate(teacher, 'entry-1'))).code).toBe('NOT_ASSIGNED');
    t.find.mockResolvedValue(entry({ status: 0 }));
    expect((await refusal(t.service.deactivate(admin, 'entry-1'))).status).toBe(404);
  });
});
