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
import type {
  AcademicYearDirectory,
  SectionDirectory,
  SubjectDirectory,
  TeachingStaff,
} from '../academic-setup/index.js';
import type { TimeSlotRepository, TimeSlotRow } from './time-slot.repository.js';
import type { TimetableChildren } from './timetable-children.js';
import type {
  TimetableEntryRepository,
  TimetableEntryRow,
  TimetableEntryWithSlot,
} from './timetable-entry.repository.js';
import { TimetableEntryService } from './timetable-entry.service.js';
import type { TimetableStaff } from './timetable-staff.js';

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

const entry = (overrides: Partial<TimetableEntryRow> = {}): TimetableEntryRow => ({
  id: 'entry-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'person-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  section_id: 'section-1',
  day_of_week: 1,
  time_slot_id: 'slot-1',
  is_break: false,
  subject_id: 'subject-1',
  staff_member_id: 'staff-1',
  ...overrides,
});
const withSlot = (row: TimetableEntryRow): TimetableEntryWithSlot => ({
  ...row,
  period_no: 1,
  label: 'Period 1',
  start_time: '08:30:00',
  end_time: '09:10:00',
});
const slotRow = (overrides: Partial<TimeSlotRow> = {}): TimeSlotRow =>
  ({
    id: 'slot-1',
    status: 1,
    institution_id: 'inst-1',
    academic_year_id: 'year-1',
    is_break: false,
    ...overrides,
  }) as TimeSlotRow;

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) {
      return {
        status: error.status as number,
        code: error.code,
        fields: (error.options.errors ?? []).map((e) => e.field),
        details: error.options.details,
      };
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

const lesson = {
  sectionId: 'section-1',
  dayOfWeek: 1,
  timeSlotId: 'slot-1',
  subjectId: 'subject-1',
  staffMemberId: 'staff-1',
};

function build(current: TimetableEntryRow | null = entry()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const withSlots = vi
    .fn<TimetableEntryRepository['withSlots']>()
    .mockImplementation(() => Promise.resolve([withSlot(current ?? entry())]));
  const find = vi.fn<TimetableEntryRepository['find']>().mockResolvedValue(current ?? undefined);
  const taken = vi.fn<TimetableEntryRepository['taken']>().mockResolvedValue(undefined);
  const insert = vi
    .fn<TimetableEntryRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(entry({ ...(values as Partial<TimetableEntryRow>), id: 'entry-new' })),
    );
  const update = vi
    .fn<TimetableEntryRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(
        entry({ ...current, ...(changes as Partial<TimetableEntryRow>), id, version: 2 }),
      ),
    );
  const findSlot = vi.fn<TimeSlotRepository['find']>().mockResolvedValue(slotRow());
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant, societyId: 'society-1' } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const requireCurrentId = vi
    .fn<AcademicYearDirectory['requireCurrentId']>()
    .mockResolvedValue('year-1');
  const contextOf = vi.fn<SectionDirectory['contextOf']>().mockResolvedValue(context);
  const requireActiveSection = vi.fn<SectionDirectory['requireActive']>().mockResolvedValue();
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
  const requireTeacher = vi.fn<TimetableStaff['requireTeacher']>().mockResolvedValue();
  const ownRecord = vi
    .fn<TimetableStaff['ownRecord']>()
    .mockResolvedValue({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-1' });
  const teacherNames = vi
    .fn<TimetableStaff['names']>()
    .mockResolvedValue(new Map([['staff-1', 'Asha Rao']]));
  const parentNames = vi
    .fn<TimetableStaff['namesForParent']>()
    .mockResolvedValue(new Map([['staff-1', 'Asha Rao']]));
  const childContextOf = vi.fn<ChildContexts['of']>().mockResolvedValue(childContext);
  const currentSectionId = vi
    .fn<TimetableChildren['currentSectionId']>()
    .mockResolvedValue('section-1');
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new TimetableEntryService(
    { transaction } as unknown as DatabaseService,
    {
      withSlots,
      find,
      taken,
      insert,
      update,
    } as unknown as TimetableEntryRepository,
    { find: findSlot } as unknown as TimeSlotRepository,
    { forPrincipal, requireInstitution } as unknown as ScopeService,
    { requireCurrentId } as unknown as AcademicYearDirectory,
    {
      contextOf,
      requireActive: requireActiveSection,
      names: sectionNames,
    } as unknown as SectionDirectory,
    { requireActive: requireSubject, names: subjectNames } as unknown as SubjectDirectory,
    { ownSectionIds } as unknown as TeachingStaff,
    {
      requireTeacher,
      ownRecord,
      names: teacherNames,
      namesForParent: parentNames,
    } as unknown as TimetableStaff,
    { currentSectionId } as unknown as TimetableChildren,
    { of: childContextOf } as unknown as ChildContexts,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
  );
  return {
    service,
    transaction,
    withSlots,
    find,
    taken,
    insert,
    update,
    findSlot,
    requireInstitution,
    requireCurrentId,
    contextOf,
    requireActiveSection,
    sectionNames,
    requireSubject,
    ownSectionIds,
    requireTeacher,
    ownRecord,
    teacherNames,
    parentNames,
    childContextOf,
    currentSectionId,
    record,
  };
}

describe('TimetableEntryService.list', () => {
  it('reads a section’s week of the current year, with the names', async () => {
    const t = build();
    const result = await t.service.list(admin, { sectionId: 'section-1' });
    expect(t.contextOf).toHaveBeenCalledWith(admin, 'section-1');
    expect(t.withSlots).toHaveBeenCalledWith(expect.anything(), {
      academicYearId: 'year-1',
      sectionId: 'section-1',
    });
    expect(result.data[0]).toMatchObject({
      sectionName: 'A',
      className: '5',
      subject: { name: 'Maths' },
      teacher: { displayName: 'Asha Rao' },
      timeSlot: { startTime: '08:30' },
    });
  });

  it('is 404 for a section the caller cannot see', async () => {
    const t = build();
    t.contextOf.mockRejectedValue(AppException.notFound());
    expect(await refusal(t.service.list(admin, { sectionId: 'x' }))).toMatchObject({ status: 404 });
  });

  it('lets a teacher read a section they lead or teach, and not any other (403 NOT_ASSIGNED)', async () => {
    const t = build();
    await t.service.list(teacher, { sectionId: 'section-1' });
    t.ownSectionIds.mockResolvedValue(new Set());
    expect(await refusal(t.service.list(teacher, { sectionId: 'section-1' }))).toMatchObject({
      status: 403,
      code: 'NOT_ASSIGNED',
    });
  });

  it('reads a teacher’s own week with `me`, at the Institution named', async () => {
    const t = build();
    await t.service.list(teacher, { staffMemberId: 'me', institutionId: 'inst-1' });
    expect(t.requireInstitution).toHaveBeenCalledWith(teacher, 'inst-1');
    expect(t.withSlots).toHaveBeenCalledWith(expect.anything(), {
      academicYearId: 'year-1',
      staffMemberId: 'staff-1',
    });
  });

  it('refuses a teacher the week of another, lets an Admin read any teacher’s, and is 404 for `me` without a staff record', async () => {
    const t = build();
    expect(
      await refusal(t.service.list(teacher, { staffMemberId: 'staff-2', institutionId: 'inst-1' })),
    ).toMatchObject({ status: 403, code: 'NOT_ASSIGNED' });
    await t.service.list(admin, { staffMemberId: 'staff-2', institutionId: 'inst-1' });
    expect(t.withSlots).toHaveBeenLastCalledWith(expect.anything(), {
      academicYearId: 'year-1',
      staffMemberId: 'staff-2',
    });
    t.ownRecord.mockResolvedValue(undefined);
    expect(
      await refusal(t.service.list(admin, { staffMemberId: 'me', institutionId: 'inst-1' })),
    ).toMatchObject({ status: 404 });
  });

  it('asks for exactly one selector, and the Institution with a teacher', async () => {
    const t = build();
    expect(await refusal(t.service.list(admin, {}))).toMatchObject({
      status: 400,
      fields: ['sectionId'],
    });
    expect(
      await refusal(t.service.list(admin, { sectionId: 's', staffMemberId: 'me' })),
    ).toMatchObject({ fields: ['staffMemberId', 'institutionId'] });
    expect(await refusal(t.service.list(admin, { staffMemberId: 'me' }))).toMatchObject({
      fields: ['institutionId'],
    });
    expect(
      await refusal(t.service.list(admin, { sectionId: 's', institutionId: 'i' })),
    ).toMatchObject({ fields: ['institutionId'] });
    expect(await refusal(t.service.list(admin, { sectionId: 's', studentId: 'c' }))).toMatchObject({
      fields: ['studentId'],
    });
  });

  it('reads a parent’s child’s section in the child’s tenant, with the names a parent may have', async () => {
    const t = build();
    const result = await t.service.list(parent, { studentId: 'child-1' });
    expect(t.childContextOf).toHaveBeenCalledWith(parent, 'child-1');
    expect(t.transaction).toHaveBeenCalledWith(childContext.tenant, expect.any(Function));
    expect(t.parentNames).toHaveBeenCalled();
    expect(t.teacherNames).not.toHaveBeenCalled();
    expect(t.sectionNames).not.toHaveBeenCalled();
    expect(result.data[0]).toMatchObject({
      sectionName: null,
      teacher: { displayName: 'Asha Rao' },
    });
  });

  it('shows a child in no section an empty week, and refuses a parent anything but the child', async () => {
    const t = build();
    t.currentSectionId.mockResolvedValue(undefined);
    expect((await t.service.list(parent, { studentId: 'child-1' })).data).toEqual([]);
    expect(t.withSlots).not.toHaveBeenCalled();
    expect(await refusal(t.service.list(parent, {}))).toMatchObject({ fields: ['studentId'] });
    expect(
      await refusal(
        t.service.list(parent, {
          studentId: 'c',
          sectionId: 's',
          staffMemberId: 'me',
          institutionId: 'i',
        }),
      ),
    ).toMatchObject({ fields: ['sectionId', 'staffMemberId', 'institutionId'] });
  });
});

describe('TimetableEntryService.create', () => {
  it('adds a lesson to the current year, checks the rules, and audits it', async () => {
    const t = build();
    const result = await t.service.create(admin, lesson);
    expect(t.requireActiveSection).toHaveBeenCalledWith(
      expect.anything(),
      'section-1',
      'sectionId',
    );
    expect(t.requireSubject).toHaveBeenCalledWith(expect.anything(), ['subject-1'], 'subjectId');
    expect(t.requireTeacher).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      'inst-1',
      'subject-1',
    );
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        society_id: 'society-1',
        institution_id: 'inst-1',
        academic_year_id: 'year-1',
        section_id: 'section-1',
        day_of_week: 1,
        time_slot_id: 'slot-1',
        is_break: false,
        subject_id: 'subject-1',
        staff_member_id: 'staff-1',
        created_by: 'person-1',
      }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'timetable_entry.created', institutionId: 'inst-1' }),
    );
    expect(result.id).toBe('entry-1');
  });

  it('adds a break without a subject and a teacher, and checks neither', async () => {
    const t = build();
    await t.service.create(admin, {
      sectionId: 'section-1',
      dayOfWeek: 2,
      timeSlotId: 'slot-1',
      isBreak: true,
    });
    expect(t.requireSubject).not.toHaveBeenCalled();
    expect(t.requireTeacher).not.toHaveBeenCalled();
    // A break has no teacher, so only the section's own period is looked at.
    expect(t.taken).toHaveBeenCalledTimes(1);
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ is_break: true, subject_id: null, staff_member_id: null }),
    );
  });

  it('refuses the wrong shape before reading anything', async () => {
    const t = build();
    expect(
      await refusal(t.service.create(admin, { ...lesson, subjectId: undefined })),
    ).toMatchObject({ status: 400, fields: ['subjectId'] });
    expect(await refusal(t.service.create(admin, { ...lesson, isBreak: true }))).toMatchObject({
      status: 400,
      fields: ['subjectId', 'staffMemberId'],
    });
    expect(t.contextOf).not.toHaveBeenCalled();
  });

  it('is 404 for a section out of reach, and 422 for a deactivated one', async () => {
    const t = build();
    t.contextOf.mockRejectedValue(AppException.notFound());
    expect(await refusal(t.service.create(admin, lesson))).toMatchObject({ status: 404 });
    const inactive = build();
    inactive.requireActiveSection.mockRejectedValue(AppException.referenceInactive('sectionId'));
    expect(await refusal(inactive.service.create(admin, lesson))).toMatchObject({
      status: 422,
      fields: ['sectionId'],
    });
  });

  it('is 400 INVALID_SLOT for a period that is missing, deactivated, of another year or a break period', async () => {
    for (const found of [
      undefined,
      slotRow({ status: 0 }),
      slotRow({ academic_year_id: 'year-0' }),
      slotRow({ is_break: true }),
    ]) {
      const t = build();
      t.findSlot.mockResolvedValue(found);
      expect(await refusal(t.service.create(admin, lesson))).toMatchObject({
        status: 400,
        code: 'INVALID_SLOT',
      });
      expect(t.insert).not.toHaveBeenCalled();
    }
  });

  it('passes on the refusals of the subject and the teacher, before any clash', async () => {
    const t = build();
    t.requireSubject.mockRejectedValue(AppException.referenceInactive('subjectId'));
    expect(await refusal(t.service.create(admin, lesson))).toMatchObject({ status: 422 });
    const u = build();
    u.requireTeacher.mockRejectedValue(AppException.businessRule('SUBJECT_NOT_TAUGHT'));
    expect(await refusal(u.service.create(admin, lesson))).toMatchObject({
      status: 422,
      code: 'SUBJECT_NOT_TAUGHT',
    });
    expect(u.taken).not.toHaveBeenCalled();
  });

  it('is 409 SECTION_SLOT_TAKEN when the section has an entry there, before the teacher is looked at', async () => {
    const t = build();
    t.taken.mockResolvedValueOnce(entry({ id: 'other' }));
    expect(await refusal(t.service.create(admin, lesson))).toMatchObject({
      status: 409,
      code: 'SECTION_SLOT_TAKEN',
    });
    expect(t.taken).toHaveBeenCalledTimes(1);
    expect(t.taken).toHaveBeenCalledWith(
      expect.anything(),
      'section_id',
      'section-1',
      1,
      'slot-1',
      undefined,
    );
  });

  it('is 409 TEACHER_DOUBLE_BOOKED, naming the section and class of the clash', async () => {
    const t = build();
    t.taken
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(entry({ id: 'other', section_id: 'section-1' }));
    expect(await refusal(t.service.create(admin, lesson))).toMatchObject({
      status: 409,
      code: 'TEACHER_DOUBLE_BOOKED',
      details: { conflict: { sectionName: 'A', className: '5' } },
    });
  });

  it('answers two saves that race with the same codes, from the unique indexes', async () => {
    const t = build();
    t.insert.mockRejectedValueOnce({ code: '23505', constraint: 'uq_timetable_teacher_slot' });
    expect(await refusal(t.service.create(admin, lesson))).toMatchObject({
      status: 409,
      code: 'TEACHER_DOUBLE_BOOKED',
    });
    t.insert.mockRejectedValueOnce({ code: '23505', constraint: 'uq_timetable_section_slot' });
    expect(await refusal(t.service.create(admin, lesson))).toMatchObject({
      status: 409,
      code: 'SECTION_SLOT_TAKEN',
    });
  });
});

describe('TimetableEntryService.update', () => {
  it('changes the day and the period, checking the clashes without the entry itself', async () => {
    const t = build();
    await t.service.update(admin, 'entry-1', { version: 1, dayOfWeek: 3 });
    expect(t.find).toHaveBeenLastCalledWith(expect.anything(), 'entry-1', true);
    expect(t.taken).toHaveBeenCalledWith(
      expect.anything(),
      'section_id',
      'section-1',
      3,
      'slot-1',
      'entry-1',
    );
    expect(t.taken).toHaveBeenCalledWith(
      expect.anything(),
      'staff_member_id',
      'staff-1',
      3,
      'slot-1',
      'entry-1',
    );
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'entry-1',
      expect.objectContaining({ day_of_week: 3, updated_by: 'person-1' }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'timetable_entry.updated',
        before: expect.objectContaining({ day_of_week: 1 }),
        after: expect.objectContaining({ day_of_week: 3 }),
      }),
    );
  });

  it('writes nothing for a request that changes nothing, whatever the rules would say', async () => {
    const t = build();
    t.findSlot.mockResolvedValue(undefined);
    await t.service.update(admin, 'entry-1', { version: 1, dayOfWeek: 1, subjectId: 'subject-1' });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(t.findSlot).not.toHaveBeenCalled();
  });

  it('makes a lesson a break by clearing the subject and the teacher', async () => {
    const t = build();
    await t.service.update(admin, 'entry-1', { version: 1, isBreak: true });
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'entry-1',
      expect.objectContaining({ is_break: true, subject_id: null, staff_member_id: null }),
    );
    expect(t.requireTeacher).not.toHaveBeenCalled();
  });

  it('refuses a break that names a subject, and a lesson made of a break without both', async () => {
    const t = build();
    expect(
      await refusal(
        t.service.update(admin, 'entry-1', { version: 1, isBreak: true, subjectId: 's' }),
      ),
    ).toMatchObject({ status: 400, fields: ['subjectId'] });
    const b = build(entry({ is_break: true, subject_id: null, staff_member_id: null }));
    expect(
      await refusal(b.service.update(admin, 'entry-1', { version: 1, isBreak: false })),
    ).toMatchObject({ status: 400, fields: ['subjectId', 'staffMemberId'] });
  });

  it('is 409 VERSION_CONFLICT before anything else, and 404 for a removed entry or one out of reach', async () => {
    const t = build(entry({ version: 4 }));
    expect(
      await refusal(t.service.update(admin, 'entry-1', { version: 1, dayOfWeek: 2 })),
    ).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(
      await refusal(build(null).service.update(admin, 'entry-1', { version: 1 })),
    ).toMatchObject({ status: 404 });
    expect(
      await refusal(build(entry({ status: 0 })).service.update(admin, 'entry-1', { version: 1 })),
    ).toMatchObject({ status: 404 });
    const out = build();
    out.requireInstitution.mockRejectedValue(AppException.notFound());
    expect(await refusal(out.service.update(admin, 'entry-1', { version: 1 }))).toMatchObject({
      status: 404,
    });
  });

  it('is 400 INVALID_SLOT for an entry of an earlier year that is changed in place', async () => {
    const t = build(entry({ academic_year_id: 'year-0' }));
    t.findSlot.mockResolvedValue(slotRow({ academic_year_id: 'year-0' }));
    expect(
      await refusal(t.service.update(admin, 'entry-1', { version: 1, dayOfWeek: 2 })),
    ).toMatchObject({ status: 400, code: 'INVALID_SLOT' });
  });
});

describe('TimetableEntryService.deactivate', () => {
  it('removes an entry and audits it', async () => {
    const t = build();
    expect(await t.service.deactivate(admin, 'entry-1')).toEqual({ id: 'entry-1', status: 0 });
    // Two removals at once must not both pass: the row is read with the lock.
    expect(t.find).toHaveBeenLastCalledWith(expect.anything(), 'entry-1', true);
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'entry-1',
      expect.objectContaining({ status: 0 }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'timetable_entry.deactivated' }),
    );
  });

  it('is 404 for an entry that is gone or already removed', async () => {
    expect(await refusal(build(null).service.deactivate(admin, 'entry-1'))).toMatchObject({
      status: 404,
    });
    expect(
      await refusal(build(entry({ status: 0 })).service.deactivate(admin, 'entry-1')),
    ).toMatchObject({ status: 404 });
  });
});
