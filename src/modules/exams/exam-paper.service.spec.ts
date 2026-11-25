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
  StaffDirectory,
  SubjectDirectory,
} from '../academic-setup/index.js';
import type { DatesheetNotifier } from './datesheet.notifier.js';
import type { CreateExamPaperDto } from './exam-paper.dto.js';
import type { ExamPaperRepository, ExamPaperRow } from './exam-paper.repository.js';
import { ExamPaperService } from './exam-paper.service.js';
import type { ExamPeople } from './exam-people.js';
import type { ExamRepository, ExamRow } from './exam.repository.js';

const principal = (roleCode: number) =>
  ({ personId: 'person-1', roleCode, societyId: 'society-1' }) as Principal;
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

const exam = (overrides: Partial<ExamRow> = {}): ExamRow => ({
  id: 'exam-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'person-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  name: 'Unit Test 1',
  exam_type: 1,
  start_date: '2026-08-10',
  end_date: '2026-08-14',
  datesheet_published_at: null,
  datesheet_published_by: null,
  ...overrides,
});

const paper = (overrides: Partial<ExamPaperRow> = {}): ExamPaperRow => ({
  id: 'paper-1',
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_by: 'person-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  exam_id: 'exam-1',
  section_id: 'section-1',
  subject_id: 'subject-1',
  exam_date: '2026-08-10',
  start_time: '09:00:00',
  end_time: '11:00:00',
  room_name: null,
  max_marks: 100,
  passing_marks: 35,
  subject_teacher_staff_member_id: null,
  invigilator_staff_member_id: null,
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

const body: CreateExamPaperDto = {
  sectionId: 'section-1',
  subjectId: 'subject-1',
  examDate: '2026-08-10',
  startTime: '09:00',
  endTime: '11:00',
};

function build(options: { exam?: ExamRow | null; paper?: ExamPaperRow | null } = {}) {
  const found = options.exam === undefined ? exam() : options.exam;
  const current = options.paper === undefined ? paper() : options.paper;
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const ofExam = vi.fn<ExamPaperRepository['ofExam']>().mockResolvedValue([paper()]);
  const ofStaff = vi.fn<ExamPaperRepository['ofStaff']>().mockResolvedValue([]);
  const findPaper = vi.fn<ExamPaperRepository['find']>().mockResolvedValue(current ?? undefined);
  const insert = vi
    .fn<ExamPaperRepository['insert']>()
    .mockImplementation((_tx, values) =>
      Promise.resolve(paper({ ...(values as Partial<ExamPaperRow>), id: 'paper-new' })),
    );
  const update = vi
    .fn<ExamPaperRepository['update']>()
    .mockImplementation((_tx, id, changes) =>
      Promise.resolve(paper({ ...current, ...(changes as Partial<ExamPaperRow>), id, version: 2 })),
    );
  const findExam = vi.fn<ExamRepository['find']>().mockResolvedValue(found ?? undefined);
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant, societyId: 'society-1' } as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const childOf = vi.fn<ChildContexts['of']>().mockResolvedValue(childContext);
  const placeOf = vi.fn<SectionDirectory['placeOf']>().mockResolvedValue({
    classId: 'class-1',
    institutionId: 'inst-1',
    active: true,
    capacity: null,
  });
  const sectionNames = vi.fn<SectionDirectory['names']>().mockResolvedValue(new Map());
  const requireSubject = vi.fn<SubjectDirectory['requireActive']>().mockResolvedValue();
  const subjectNames = vi
    .fn<SubjectDirectory['names']>()
    .mockResolvedValue(new Map([['subject-1', 'Mathematics']]));
  const staffNames = vi.fn<StaffDirectory['names']>().mockResolvedValue(new Map());
  const ownRecord = vi
    .fn<StaffDirectory['ownRecord']>()
    .mockResolvedValue({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-1' });
  const requireSubjectTeacher = vi.fn<ExamPeople['requireSubjectTeacher']>().mockResolvedValue();
  const requireInvigilator = vi.fn<ExamPeople['requireInvigilator']>().mockResolvedValue();
  const yearToRead = vi.fn<AcademicYearDirectory['yearToRead']>().mockResolvedValue('year-1');
  const changed = vi.fn<DatesheetNotifier['changed']>().mockResolvedValue();
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new ExamPaperService(
    { transaction } as unknown as DatabaseService,
    { ofExam, ofStaff, find: findPaper, insert, update } as unknown as ExamPaperRepository,
    { find: findExam } as unknown as ExamRepository,
    { forPrincipal, requireInstitution } as unknown as ScopeService,
    { of: childOf } as unknown as ChildContexts,
    { placeOf, names: sectionNames } as unknown as SectionDirectory,
    { requireActive: requireSubject, names: subjectNames } as unknown as SubjectDirectory,
    { names: staffNames, ownRecord } as unknown as StaffDirectory,
    { requireSubjectTeacher, requireInvigilator } as unknown as ExamPeople,
    { yearToRead } as unknown as AcademicYearDirectory,
    { changed } as unknown as DatesheetNotifier,
    {
      describe: vi.fn<PersonDirectory['describe']>().mockResolvedValue(new Map()),
    } as unknown as PersonDirectory,
    { record } as unknown as AuditService,
  );
  return {
    service,
    transaction,
    ofExam,
    ofStaff,
    insert,
    update,
    findExam,
    requireInstitution,
    childOf,
    placeOf,
    requireSubject,
    ownRecord,
    requireSubjectTeacher,
    requireInvigilator,
    yearToRead,
    changed,
    record,
  };
}

const published = () =>
  exam({
    datesheet_published_at: new Date('2026-08-01T00:00:00.000Z'),
    datesheet_published_by: 'p',
  });

describe('ExamPaperService.list', () => {
  it('reads an exam’s papers in the Institution the caller reaches, one section’s when named', async () => {
    const t = build();
    const result = await t.service.list(admin, 'exam-1', { sectionId: 'section-1' });
    expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'inst-1');
    expect(t.transaction).toHaveBeenCalledWith(narrowed, expect.any(Function));
    expect(t.ofExam).toHaveBeenCalledWith(expect.anything(), 'exam-1', 'section-1');
    expect(result.data[0]).toMatchObject({ subject: { name: 'Mathematics' } });
  });

  it('reads a parent’s child’s section in the child’s tenant, without names of people', async () => {
    const t = build();
    await t.service.list(parent, 'exam-1', { studentId: 'child-1' });
    expect(t.childOf).toHaveBeenCalledWith(parent, 'child-1');
    expect(t.transaction).toHaveBeenCalledWith(childContext.tenant, expect.any(Function));
    expect(await refusal(t.service.list(parent, 'exam-1', {}))).toMatchObject({
      fields: ['studentId'],
    });
    expect(
      await refusal(t.service.list(parent, 'exam-1', { studentId: 'child-1', sectionId: 'x' })),
    ).toMatchObject({ fields: ['sectionId'] });
  });

  it('refuses a child to anyone but a parent, and is 404 for an exam of another Institution or a deactivated one', async () => {
    const t = build();
    expect(await refusal(t.service.list(admin, 'exam-1', { studentId: 'child-1' }))).toMatchObject({
      status: 400,
      fields: ['studentId'],
    });
    t.findExam.mockResolvedValue(exam({ institution_id: 'inst-2' }));
    t.requireInstitution.mockResolvedValue({ ...childContext, institutionId: 'inst-1' });
    expect(await refusal(t.service.list(parent, 'exam-1', { studentId: 'child-1' }))).toMatchObject(
      { status: 404 },
    );
    expect(
      await refusal(build({ exam: exam({ status: 0 }) }).service.list(admin, 'exam-1', {})),
    ).toMatchObject({ status: 404 });
    expect(await refusal(build({ exam: null }).service.list(admin, 'exam-1', {}))).toMatchObject({
      status: 404,
    });
  });
});

describe('ExamPaperService.create', () => {
  it('adds the paper with the marks defaults, audits it, and tells no one while the datesheet is unpublished', async () => {
    const t = build();
    const result = await t.service.create(admin, 'exam-1', {
      ...body,
      roomName: 'Room 1',
      subjectTeacherStaffMemberId: 'staff-1',
      invigilatorStaffMemberId: 'staff-2',
    });
    expect(t.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        exam_id: 'exam-1',
        academic_year_id: 'year-1',
        section_id: 'section-1',
        room_name: 'Room 1',
        max_marks: 100,
        passing_marks: 35,
        created_by: 'person-1',
      }),
    );
    expect(t.requireSubject).toHaveBeenCalledWith(expect.anything(), ['subject-1'], 'subjectId');
    expect(t.requireSubjectTeacher).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      'inst-1',
      'subject-1',
      'subjectTeacherStaffMemberId',
    );
    expect(t.requireInvigilator).toHaveBeenCalledWith(
      expect.anything(),
      'staff-2',
      'inst-1',
      'invigilatorStaffMemberId',
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'exam_paper.created', entityType: 'exam_paper' }),
    );
    expect(t.changed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'paper-new', startTime: '09:00' });
  });

  it('tells the section when the datesheet is published', async () => {
    const t = build({ exam: published() });
    await t.service.create(admin, 'exam-1', body);
    expect(t.changed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'exam-1' }),
      expect.objectContaining({ id: 'paper-new' }),
      'added',
      [],
      'person-1',
    );
  });

  it('refuses before touching the database a bad time or marks, and after reading the exam a bad day', async () => {
    const t = build();
    expect(
      await refusal(t.service.create(admin, 'exam-1', { ...body, endTime: '09:00' })),
    ).toMatchObject({ status: 400, fields: ['endTime'] });
    expect(
      await refusal(t.service.create(admin, 'exam-1', { ...body, maxMarks: 50, passingMarks: 51 })),
    ).toMatchObject({ fields: ['passingMarks'] });
    expect(
      await refusal(t.service.create(admin, 'exam-1', { ...body, examDate: '2026-08-15' })),
    ).toMatchObject({ fields: ['examDate'] });
    expect(t.insert).not.toHaveBeenCalled();
  });

  it('is 404 for a section of another Institution or none, 422 for a deactivated one, and 404 for a deactivated exam', async () => {
    const t = build();
    t.placeOf.mockResolvedValueOnce({
      classId: 'c',
      institutionId: 'inst-2',
      active: true,
      capacity: null,
    });
    expect(await refusal(t.service.create(admin, 'exam-1', body))).toMatchObject({ status: 404 });
    t.placeOf.mockResolvedValueOnce(undefined);
    expect(await refusal(t.service.create(admin, 'exam-1', body))).toMatchObject({ status: 404 });
    t.placeOf.mockResolvedValueOnce({
      classId: 'c',
      institutionId: 'inst-1',
      active: false,
      capacity: null,
    });
    expect(await refusal(t.service.create(admin, 'exam-1', body))).toEqual({
      status: 422,
      code: 'REFERENCE_INACTIVE',
      fields: ['sectionId'],
    });
    expect(
      await refusal(build({ exam: exam({ status: 0 }) }).service.create(admin, 'exam-1', body)),
    ).toMatchObject({ status: 404 });
    expect(t.insert).not.toHaveBeenCalled();
  });

  it('answers the clash codes of the database as the API names them', async () => {
    const t = build();
    t.insert.mockRejectedValueOnce({ code: '23P01', constraint: 'ex_exam_papers_room_time' });
    expect(await refusal(t.service.create(admin, 'exam-1', body))).toEqual({
      status: 409,
      code: 'ROOM_TAKEN',
      fields: ['roomName'],
    });
  });
});

describe('ExamPaperService.update', () => {
  it('changes what the request changes, checks only that, audits and leaves the version to the table', async () => {
    const t = build();
    const result = await t.service.update(admin, 'paper-1', {
      version: 1,
      startTime: '10:00',
      roomName: 'Hall',
      invigilatorStaffMemberId: 'staff-2',
    });
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'paper-1',
      expect.objectContaining({
        start_time: '10:00',
        room_name: 'Hall',
        invigilator_staff_member_id: 'staff-2',
        updated_by: 'person-1',
      }),
    );
    expect(t.requireInvigilator).toHaveBeenCalledWith(
      expect.anything(),
      'staff-2',
      'inst-1',
      'invigilatorStaffMemberId',
    );
    expect(t.requireSubjectTeacher).not.toHaveBeenCalled();
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'exam_paper.updated',
        before: expect.objectContaining({ start_time: '09:00' }),
        after: expect.objectContaining({ start_time: '10:00', room_name: 'Hall' }),
      }),
    );
    expect(result).toMatchObject({ version: 2, startTime: '10:00' });
  });

  it('writes and tells no one for a request that changes nothing', async () => {
    const t = build({ exam: published() });
    const result = await t.service.update(admin, 'paper-1', {
      version: 1,
      startTime: '09:00',
      examDate: '2026-08-10',
    });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
    expect(t.changed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ version: 1 });
  });

  it('tells the section, and the staff it had, once the datesheet is published', async () => {
    const t = build({
      exam: published(),
      paper: paper({ subject_teacher_staff_member_id: 'staff-1' }),
    });
    await t.service.update(admin, 'paper-1', { version: 1, subjectTeacherStaffMemberId: null });
    expect(t.changed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'exam-1' }),
      expect.objectContaining({ id: 'paper-1' }),
      'changed',
      ['staff-1', null],
      'person-1',
    );
  });

  it('refuses a stale version, a day out of the exam, a bad end and marks, each on what changes', async () => {
    const t = build();
    expect(await refusal(t.service.update(admin, 'paper-1', { version: 7 }))).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
    });
    expect(
      await refusal(t.service.update(admin, 'paper-1', { version: 1, examDate: '2026-08-20' })),
    ).toMatchObject({ fields: ['examDate'] });
    expect(
      await refusal(t.service.update(admin, 'paper-1', { version: 1, endTime: '08:00' })),
    ).toMatchObject({ fields: ['endTime'] });
    expect(
      await refusal(t.service.update(admin, 'paper-1', { version: 1, maxMarks: 20 })),
    ).toMatchObject({ fields: ['passingMarks'] });
    expect(t.update).not.toHaveBeenCalled();
  });

  it('is 404 for a paper that is gone or out of reach, and when it is removed under the lock', async () => {
    expect(
      await refusal(build({ paper: null }).service.update(admin, 'paper-1', { version: 1 })),
    ).toMatchObject({ status: 404 });
    const t = build({ paper: paper({ status: 0 }) });
    expect(await refusal(t.service.update(admin, 'paper-1', { version: 1 }))).toMatchObject({
      status: 404,
    });
  });
});

describe('ExamPaperService.deactivate', () => {
  it('removes the paper, audits it, and tells the section only when the datesheet is published', async () => {
    const t = build();
    await expect(t.service.deactivate(admin, 'paper-1')).resolves.toEqual({
      id: 'paper-1',
      status: 0,
    });
    expect(t.update).toHaveBeenCalledWith(
      expect.anything(),
      'paper-1',
      expect.objectContaining({ status: 0 }),
    );
    expect(t.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'exam_paper.deactivated' }),
    );
    expect(t.changed).not.toHaveBeenCalled();
    const live = build({ exam: published() });
    await live.service.deactivate(admin, 'paper-1');
    expect(live.changed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'paper-1' }),
      'removed',
      [],
      'person-1',
    );
  });

  it('is 404 for a removed paper', async () => {
    expect(
      await refusal(build({ paper: paper({ status: 0 }) }).service.deactivate(admin, 'paper-1')),
    ).toMatchObject({ status: 404 });
  });
});

describe('ExamPaperService.mine', () => {
  const mineRow = {
    ...paper({ subject_teacher_staff_member_id: 'staff-1' }),
    exam_name: 'Unit Test 1',
  };

  it('reads the caller’s own papers of the current year, with their duties', async () => {
    const t = build();
    t.ofStaff.mockResolvedValue([mineRow]);
    const result = await t.service.mine(teacher, { institutionId: 'inst-1', mine: true });
    expect(t.requireInstitution).toHaveBeenCalledWith(teacher, 'inst-1');
    expect(t.yearToRead).toHaveBeenCalledWith(expect.anything(), 'inst-1', undefined);
    expect(t.ofStaff).toHaveBeenCalledWith(expect.anything(), 'year-1', 'staff-1');
    expect(result.data[0]).toMatchObject({
      exam: { id: 'exam-1', name: 'Unit Test 1' },
      duties: ['subjectTeacher'],
    });
  });

  it('lets an Admin name a staff member and a year, and a teacher only themselves', async () => {
    const t = build();
    await t.service.mine(admin, {
      institutionId: 'inst-1',
      staffMemberId: 'staff-9',
      academicYearId: 'year-7',
    });
    expect(t.yearToRead).toHaveBeenCalledWith(expect.anything(), 'inst-1', 'year-7');
    expect(t.ofStaff).toHaveBeenCalledWith(expect.anything(), 'year-1', 'staff-9');
    await t.service.mine(teacher, { institutionId: 'inst-1', staffMemberId: 'staff-1' });
    expect(
      await refusal(t.service.mine(teacher, { institutionId: 'inst-1', staffMemberId: 'staff-9' })),
    ).toEqual({ status: 403, code: 'NOT_ASSIGNED', fields: [] });
  });

  it('is 400 without one of mine and a name or with both, and 404 for no staff record', async () => {
    const t = build();
    expect(await refusal(t.service.mine(admin, { institutionId: 'inst-1' }))).toMatchObject({
      status: 400,
      fields: ['mine'],
    });
    expect(
      await refusal(
        t.service.mine(admin, { institutionId: 'inst-1', mine: true, staffMemberId: 'staff-1' }),
      ),
    ).toMatchObject({ status: 400, fields: ['staffMemberId'] });
    t.ownRecord.mockResolvedValue(undefined);
    expect(
      await refusal(t.service.mine(admin, { institutionId: 'inst-1', mine: true })),
    ).toMatchObject({ status: 404 });
    expect(t.ofStaff).not.toHaveBeenCalled();
  });
});
