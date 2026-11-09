import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, Tx } from '../../platform/database/index.js';
import type { ScopeService } from '../../platform/tenancy/index.js';
import type {
  AcademicYearDirectory,
  SectionDirectory,
  SubjectDirectory,
} from '../academic-setup/index.js';
import type {
  CreateTeachingAssignmentDto,
  ListTeachingAssignmentsQueryDto,
  SetClassTeacherDto,
} from './assignment.dto.js';
import type {
  AssignmentRepository,
  ClassTeacherRow,
  TeachingRow,
  TeachingView,
} from './assignment.repository.js';
import { AssignmentService } from './assignment.service.js';
import type { StaffContext } from './staff-context.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';

const now = new Date('2026-11-08T04:30:00.000Z');
const principal = (roleCode: number, personId = 'admin-1') =>
  ({ personId, roleCode, societyId: 'society-1' }) as unknown as Principal;
const admin = principal(3);
const teacher = principal(4, 'user-1');

const staff = (overrides: Partial<StaffRow> = {}): StaffRow =>
  ({
    id: 'staff-1',
    society_id: 'society-1',
    home_institution_id: 'institution-1',
    user_id: 'user-1',
    first_name: 'Meera',
    last_name: 'Rao',
    status: 1,
    access_blocked_at: null,
    ...overrides,
  }) as StaffRow;

const leads = (overrides: Partial<ClassTeacherRow> = {}): ClassTeacherRow =>
  ({
    id: 'lead-1',
    academic_year_id: 'year-1',
    section_id: 'section-1',
    staff_member_id: 'staff-1',
    ended_at: null,
    ...overrides,
  }) as ClassTeacherRow;

const teaching = (overrides: Partial<TeachingRow> = {}): TeachingRow =>
  ({
    id: 'assignment-1',
    created_at: now,
    society_id: 'society-1',
    institution_id: 'institution-1',
    academic_year_id: 'year-1',
    section_id: 'section-1',
    subject_id: 'subject-1',
    staff_member_id: 'staff-1',
    ended_at: null,
    ...overrides,
  }) as TeachingRow;

const view = (overrides: Partial<TeachingView> = {}): TeachingView => ({
  ...teaching(),
  staff_first_name: 'Meera',
  staff_last_name: 'Rao',
  ...overrides,
});

function build(current: StaffRow | null = staff()) {
  const tx = {} as Tx;
  const transaction = vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx));
  const find = vi.fn<StaffRepository['find']>().mockResolvedValue(current ?? undefined);
  const subjectIds = vi.fn<StaffRepository['subjectIds']>().mockResolvedValue(['subject-1']);
  const activeOfUser = vi.fn<StaffRepository['activeOfUser']>().mockResolvedValue(staff());
  const context = {
    institutionId: 'institution-1',
    societyId: 'society-1',
    tenant: { societyId: 'society-1', institutionIds: ['institution-1'] },
  };
  const of = vi.fn<StaffContext['of']>().mockResolvedValue(context);
  const requireInstitution = vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context);
  const forPrincipal = vi
    .fn<ScopeService['forPrincipal']>()
    .mockResolvedValue({ tenant: context.tenant } as unknown as Awaited<
      ReturnType<ScopeService['forPrincipal']>
    >);
  const classTeacherOf = vi.fn<AssignmentRepository['classTeacherOf']>().mockResolvedValue([]);
  const insertClassTeacher = vi
    .fn<AssignmentRepository['insertClassTeacher']>()
    .mockResolvedValue(leads({ id: 'lead-2', section_id: 'section-2' }));
  const endClassTeacher = vi.fn<AssignmentRepository['endClassTeacher']>().mockResolvedValue();
  const insertTeaching = vi
    .fn<AssignmentRepository['insertTeaching']>()
    .mockResolvedValue(teaching());
  const findTeaching = vi.fn<AssignmentRepository['findTeaching']>().mockResolvedValue(teaching());
  const endTeaching = vi.fn<AssignmentRepository['endTeaching']>().mockResolvedValue();
  const pageTeaching = vi
    .fn<AssignmentRepository['pageTeaching']>()
    .mockResolvedValue({ rows: [view()], total: 41 });
  const requireYear = vi.fn<AcademicYearDirectory['requireActive']>().mockResolvedValue();
  const currentId = vi.fn<AcademicYearDirectory['currentId']>().mockResolvedValue('year-1');
  const requireSection = vi.fn<SectionDirectory['requireActive']>().mockResolvedValue();
  const sectionNames = vi
    .fn<SectionDirectory['names']>()
    .mockResolvedValue(
      new Map([['section-1', { displayName: 'A', classId: 'class-1', className: 'Class 5' }]]),
    );
  const requireSubject = vi.fn<SubjectDirectory['requireActive']>().mockResolvedValue();
  const subjectNames = vi
    .fn<SubjectDirectory['names']>()
    .mockResolvedValue(new Map([['subject-1', 'Maths']]));
  const record = vi.fn<AuditService['record']>().mockResolvedValue('audit-1');
  const service = new AssignmentService(
    { transaction } as unknown as DatabaseService,
    { find, subjectIds, activeOfUser } as unknown as StaffRepository,
    { of } as unknown as StaffContext,
    { requireInstitution, forPrincipal } as unknown as ScopeService,
    {
      classTeacherOf,
      insertClassTeacher,
      endClassTeacher,
      insertTeaching,
      findTeaching,
      endTeaching,
      pageTeaching,
    } as unknown as AssignmentRepository,
    { requireActive: requireYear, currentId } as unknown as AcademicYearDirectory,
    { requireActive: requireSection, names: sectionNames } as unknown as SectionDirectory,
    { requireActive: requireSubject, names: subjectNames } as unknown as SubjectDirectory,
    { record } as unknown as AuditService,
    new FixedClock(now.toISOString()),
  );
  return {
    service,
    find,
    subjectIds,
    activeOfUser,
    of,
    requireInstitution,
    forPrincipal,
    classTeacherOf,
    insertClassTeacher,
    endClassTeacher,
    insertTeaching,
    findTeaching,
    endTeaching,
    pageTeaching,
    requireYear,
    currentId,
    requireSection,
    requireSubject,
    record,
  };
}

const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

const duplicateOf = (constraint: string) =>
  Object.assign(new Error('duplicate'), { code: '23505', constraint });

const set = (sectionId: string | null): SetClassTeacherDto => ({
  academicYearId: 'year-1',
  sectionId,
});

const query = (fields: object = {}) =>
  ({
    institutionId: 'institution-1',
    page: 2,
    limit: 20,
    ...fields,
  }) as ListTeachingAssignmentsQueryDto;

describe('AssignmentService', () => {
  describe('setClassTeacher (STF-09)', () => {
    it('makes the staff member class teacher of the section, checking the year and the section, and audits it', async () => {
      const t = build();
      const result = await t.service.setClassTeacher(admin, 'staff-1', set('section-2'));
      expect(t.of).toHaveBeenCalledWith(admin, 'staff-1');
      expect(t.find).toHaveBeenCalledWith(expect.anything(), 'staff-1', true);
      expect(t.requireYear).toHaveBeenCalledWith(
        expect.anything(),
        'year-1',
        'institution-1',
        'academicYearId',
      );
      expect(t.requireSection).toHaveBeenCalledWith(expect.anything(), 'section-2', 'sectionId');
      expect(t.insertClassTeacher).toHaveBeenCalledWith(expect.anything(), {
        created_by: 'admin-1',
        created_at: now,
        society_id: 'society-1',
        institution_id: 'institution-1',
        academic_year_id: 'year-1',
        section_id: 'section-2',
        staff_member_id: 'staff-1',
      });
      expect(t.endClassTeacher).not.toHaveBeenCalled();
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'staff.class_teacher_changed',
        institutionId: 'institution-1',
        entityType: 'staff_member',
        entityId: 'staff-1',
        before: { academicYearId: 'year-1', sectionId: null },
        after: { academicYearId: 'year-1', sectionId: 'section-2' },
      });
      expect(result).toEqual({ academicYearId: 'year-1', sectionId: 'section-2' });
    });

    it('moves a class teacher who leads another section that year: the old row ends, one entry in the audit', async () => {
      const t = build();
      t.classTeacherOf.mockResolvedValue([leads()]);
      await t.service.setClassTeacher(admin, 'staff-1', set('section-2'));
      expect(t.endClassTeacher).toHaveBeenCalledWith(expect.anything(), 'lead-1', 'admin-1', now);
      expect(t.insertClassTeacher).toHaveBeenCalledTimes(1);
      expect(t.record).toHaveBeenCalledTimes(1);
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        before: { sectionId: 'section-1' },
        after: { sectionId: 'section-2' },
      });
    });

    it('leaves a leader of another year alone', async () => {
      const t = build();
      t.classTeacherOf.mockResolvedValue([leads({ academic_year_id: 'year-0' })]);
      await t.service.setClassTeacher(admin, 'staff-1', set('section-2'));
      expect(t.endClassTeacher).not.toHaveBeenCalled();
    });

    it('writes nothing for the section they already lead that year, and checks nothing', async () => {
      const t = build();
      t.classTeacherOf.mockResolvedValue([leads()]);
      expect(await t.service.setClassTeacher(admin, 'staff-1', set('section-1'))).toEqual({
        academicYearId: 'year-1',
        sectionId: 'section-1',
      });
      expect(t.insertClassTeacher).not.toHaveBeenCalled();
      expect(t.endClassTeacher).not.toHaveBeenCalled();
      expect(t.record).not.toHaveBeenCalled();
    });

    it('ends the assignment with null, audits it, and is 200 null again when there is none', async () => {
      const t = build();
      t.classTeacherOf.mockResolvedValue([leads()]);
      expect(await t.service.setClassTeacher(admin, 'staff-1', set(null))).toBeNull();
      expect(t.endClassTeacher).toHaveBeenCalledWith(expect.anything(), 'lead-1', 'admin-1', now);
      expect(t.requireSection).not.toHaveBeenCalled();
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        before: { academicYearId: 'year-1', sectionId: 'section-1' },
        after: { academicYearId: 'year-1', sectionId: null },
      });
      const none = build();
      expect(await none.service.setClassTeacher(admin, 'staff-1', set(null))).toBeNull();
      expect(none.endClassTeacher).not.toHaveBeenCalled();
      expect(none.record).not.toHaveBeenCalled();
    });

    it('lets a blocked staff member be released, but not given a section', async () => {
      const blocked = staff({ access_blocked_at: now });
      const t = build(blocked);
      t.classTeacherOf.mockResolvedValue([leads()]);
      await t.service.setClassTeacher(admin, 'staff-1', set(null));
      expect(t.endClassTeacher).toHaveBeenCalledTimes(1);
      expect(
        await fail(build(blocked).service.setClassTeacher(admin, 'staff-1', set('s'))),
      ).toEqual({ status: 422, code: 'STAFF_BLOCKED' });
    });

    it.each([
      ['not found', null, { status: 404, code: 'NOT_FOUND' }],
      ['deactivated', staff({ status: 0 }), { status: 404, code: 'NOT_FOUND' }],
    ])('is refused for a record that is %s', async (_name, current, expected) => {
      const t = build(current);
      expect(await fail(t.service.setClassTeacher(admin, 'staff-1', set('section-2')))).toEqual(
        expected,
      );
      expect(t.insertClassTeacher).not.toHaveBeenCalled();
    });

    it('passes on the refusal of the year, the section or the caller’s reach, writing nothing', async () => {
      const year = build();
      year.requireYear.mockRejectedValue(AppException.referenceInactive('academicYearId'));
      expect(await fail(year.service.setClassTeacher(admin, 'staff-1', set('s')))).toEqual({
        status: 422,
        code: 'REFERENCE_INACTIVE',
      });
      const section = build();
      section.requireSection.mockRejectedValue(AppException.notFound());
      expect(await fail(section.service.setClassTeacher(admin, 'staff-1', set('s')))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      const reach = build();
      reach.of.mockRejectedValue(AppException.notFound());
      expect(await fail(reach.service.setClassTeacher(admin, 'staff-1', set('s')))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      for (const t of [year, section, reach]) expect(t.insertClassTeacher).not.toHaveBeenCalled();
    });

    it('is 409 CLASS_TEACHER_TAKEN when the database says the section has a class teacher, and lets other failures through', async () => {
      const t = build();
      t.insertClassTeacher.mockRejectedValue(duplicateOf('uq_class_teacher_section'));
      expect(await fail(t.service.setClassTeacher(admin, 'staff-1', set('section-2')))).toEqual({
        status: 409,
        code: 'CLASS_TEACHER_TAKEN',
      });
      expect(t.record).not.toHaveBeenCalled();
      t.insertClassTeacher.mockRejectedValue(new Error('boom'));
      await expect(t.service.setClassTeacher(admin, 'staff-1', set('section-2'))).rejects.toThrow(
        'boom',
      );
    });
  });

  describe('list (ASG-01)', () => {
    it('lists the assignments of the Institution’s current year by teacher, with names and the page', async () => {
      const t = build();
      const result = await t.service.list(admin, query());
      expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'institution-1');
      expect(t.currentId).toHaveBeenCalledWith(expect.anything(), 'institution-1');
      expect(t.pageTeaching).toHaveBeenCalledWith(
        expect.anything(),
        {
          institutionId: 'institution-1',
          academicYearId: 'year-1',
          sectionId: undefined,
          subjectId: undefined,
          staffMemberId: undefined,
        },
        20,
        20,
      );
      expect(result.data).toEqual([
        {
          id: 'assignment-1',
          institutionId: 'institution-1',
          academicYearId: 'year-1',
          section: { id: 'section-1', displayName: 'A', classId: 'class-1', className: 'Class 5' },
          subject: { id: 'subject-1', name: 'Maths' },
          staffMember: { id: 'staff-1', firstName: 'Meera', lastName: 'Rao' },
          createdAt: now.toISOString(),
        },
      ]);
      expect(result.options.meta).toEqual({ page: 2, limit: 20, totalItems: 41, totalPages: 3 });
    });

    it('takes the year and the filters it is given, and does not look for the current year', async () => {
      const t = build();
      await t.service.list(
        admin,
        query({
          academicYearId: 'year-9',
          sectionId: 'section-1',
          subjectId: 'subject-1',
          staffMemberId: 'staff-2',
        }),
      );
      expect(t.currentId).not.toHaveBeenCalled();
      expect(t.pageTeaching.mock.calls[0]![1]).toEqual({
        institutionId: 'institution-1',
        academicYearId: 'year-9',
        sectionId: 'section-1',
        subjectId: 'subject-1',
        staffMemberId: 'staff-2',
      });
    });

    it('is an empty list when the Institution has no current year, without reading', async () => {
      const t = build();
      t.currentId.mockResolvedValue(null);
      const result = await t.service.list(admin, query());
      expect(result.data).toEqual([]);
      expect(result.options.meta).toMatchObject({ totalItems: 0 });
      expect(t.pageTeaching).not.toHaveBeenCalled();
    });

    it('reads only a teacher’s own assignments, and nothing when they ask for somebody else’s or have no record', async () => {
      const own = build();
      await own.service.list(teacher, query());
      expect(own.activeOfUser).toHaveBeenCalledWith(expect.anything(), 'user-1');
      expect(own.pageTeaching.mock.calls[0]![1]).toMatchObject({ staffMemberId: 'staff-1' });
      const same = build();
      await same.service.list(teacher, query({ staffMemberId: 'staff-1' }));
      expect(same.pageTeaching).toHaveBeenCalledTimes(1);
      const other = build();
      expect((await other.service.list(teacher, query({ staffMemberId: 'staff-2' }))).data).toEqual(
        [],
      );
      expect(other.pageTeaching).not.toHaveBeenCalled();
      const none = build();
      none.activeOfUser.mockResolvedValue(undefined);
      expect((await none.service.list(teacher, query())).data).toEqual([]);
      expect(none.pageTeaching).not.toHaveBeenCalled();
    });

    it('does not look the teacher’s record up for an Owner or an Admin', async () => {
      const t = build();
      await t.service.list(admin, query());
      expect(t.activeOfUser).not.toHaveBeenCalled();
    });

    it('passes on a refusal of the scope check without reading', async () => {
      const t = build();
      t.requireInstitution.mockRejectedValue(AppException.notFound());
      expect(await fail(t.service.list(admin, query()))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(t.pageTeaching).not.toHaveBeenCalled();
    });
  });

  describe('create (ASG-02)', () => {
    const body: CreateTeachingAssignmentDto = {
      staffMemberId: 'staff-1',
      academicYearId: 'year-1',
      sectionId: 'section-1',
      subjectId: 'subject-1',
    };

    it('locks the record, checks the year, section and subject, writes the assignment and audits it', async () => {
      const t = build();
      const result = await t.service.create(admin, body);
      expect(t.of).toHaveBeenCalledWith(admin, 'staff-1');
      expect(t.find).toHaveBeenCalledWith(expect.anything(), 'staff-1', true);
      expect(t.requireYear).toHaveBeenCalledWith(
        expect.anything(),
        'year-1',
        'institution-1',
        'academicYearId',
      );
      expect(t.requireSection).toHaveBeenCalledWith(expect.anything(), 'section-1', 'sectionId');
      expect(t.requireSubject).toHaveBeenCalledWith(expect.anything(), ['subject-1'], 'subjectId');
      expect(t.insertTeaching).toHaveBeenCalledWith(expect.anything(), {
        created_by: 'admin-1',
        created_at: now,
        society_id: 'society-1',
        institution_id: 'institution-1',
        academic_year_id: 'year-1',
        section_id: 'section-1',
        subject_id: 'subject-1',
        staff_member_id: 'staff-1',
      });
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'assignment.created',
        institutionId: 'institution-1',
        entityType: 'teaching_assignment',
        entityId: 'assignment-1',
        after: {
          staffMemberId: 'staff-1',
          academicYearId: 'year-1',
          sectionId: 'section-1',
          subjectId: 'subject-1',
        },
      });
      expect(result).toMatchObject({
        id: 'assignment-1',
        section: { displayName: 'A', className: 'Class 5' },
        subject: { name: 'Maths' },
        staffMember: { id: 'staff-1', firstName: 'Meera', lastName: 'Rao' },
      });
    });

    it.each([
      ['not found', null, { status: 404, code: 'NOT_FOUND' }],
      ['deactivated', staff({ status: 0 }), { status: 404, code: 'NOT_FOUND' }],
      ['blocked', staff({ access_blocked_at: now }), { status: 422, code: 'STAFF_BLOCKED' }],
    ])('refuses a record that is %s, writing nothing', async (_name, current, expected) => {
      const t = build(current);
      expect(await fail(t.service.create(admin, body))).toEqual(expected);
      expect(t.insertTeaching).not.toHaveBeenCalled();
    });

    it('is 422 SUBJECT_NOT_TAUGHT for a subject the teacher cannot teach', async () => {
      const t = build();
      t.subjectIds.mockResolvedValue(['subject-2']);
      expect(await fail(t.service.create(admin, body))).toEqual({
        status: 422,
        code: 'SUBJECT_NOT_TAUGHT',
      });
      expect(t.subjectIds).toHaveBeenCalledWith(expect.anything(), 'staff-1');
      expect(t.insertTeaching).not.toHaveBeenCalled();
    });

    it('passes on the refusal of a subject that is not there or not active, and writes nothing', async () => {
      const t = build();
      t.requireSubject.mockRejectedValue(AppException.referenceInactive('subjectId'));
      expect(await fail(t.service.create(admin, body))).toEqual({
        status: 422,
        code: 'REFERENCE_INACTIVE',
      });
      expect(t.insertTeaching).not.toHaveBeenCalled();
    });

    it('is 409 DUPLICATE on the subject when the same assignment holds, and lets other failures through', async () => {
      const t = build();
      t.insertTeaching.mockRejectedValue(duplicateOf('uq_teaching_assignments_active'));
      expect(await fail(t.service.create(admin, body))).toEqual({
        status: 409,
        code: 'DUPLICATE',
      });
      expect(t.record).not.toHaveBeenCalled();
      t.insertTeaching.mockRejectedValue(new Error('boom'));
      await expect(t.service.create(admin, body)).rejects.toThrow('boom');
    });
  });

  describe('end (ASG-03)', () => {
    it('ends the assignment under the Institution’s scope, locked, and audits what it was', async () => {
      const t = build();
      await t.service.end(admin, 'assignment-1');
      expect(t.requireInstitution).toHaveBeenCalledWith(admin, 'institution-1');
      expect(t.findTeaching).toHaveBeenLastCalledWith(expect.anything(), 'assignment-1', true);
      expect(t.endTeaching).toHaveBeenCalledWith(expect.anything(), 'assignment-1', 'admin-1', now);
      expect(t.record.mock.calls[0]![1]).toMatchObject({
        action: 'assignment.ended',
        institutionId: 'institution-1',
        entityType: 'teaching_assignment',
        entityId: 'assignment-1',
        before: {
          staffMemberId: 'staff-1',
          academicYearId: 'year-1',
          sectionId: 'section-1',
          subjectId: 'subject-1',
        },
      });
    });

    it('is 404 for an assignment that is not there or has ended, before the scope is checked or anything written', async () => {
      for (const found of [undefined, teaching({ ended_at: now })]) {
        const t = build();
        t.findTeaching.mockResolvedValue(found);
        expect(await fail(t.service.end(admin, 'assignment-1'))).toEqual({
          status: 404,
          code: 'NOT_FOUND',
        });
        expect(t.requireInstitution).not.toHaveBeenCalled();
        expect(t.endTeaching).not.toHaveBeenCalled();
      }
    });

    it('is 404 when it ended between the read and the lock, and passes on a refusal of the scope check', async () => {
      const raced = build();
      raced.findTeaching
        .mockResolvedValueOnce(teaching())
        .mockResolvedValueOnce(teaching({ ended_at: now }));
      expect(await fail(raced.service.end(admin, 'assignment-1'))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(raced.endTeaching).not.toHaveBeenCalled();
      const reach = build();
      reach.requireInstitution.mockRejectedValue(AppException.notFound());
      expect(await fail(reach.service.end(admin, 'assignment-1'))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(reach.endTeaching).not.toHaveBeenCalled();
    });
  });
});
