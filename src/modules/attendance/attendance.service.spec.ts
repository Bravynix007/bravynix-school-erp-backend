import type { Principal } from '../../common/auth/access-token-verifier.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { AuditService } from '../../platform/audit/index.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { IdempotencyService } from '../../platform/idempotency/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { Notifications } from '../../platform/notifications/index.js';
import type { InstitutionContext, ScopeService } from '../../platform/tenancy/index.js';
import type { AcademicYearDirectory, SectionDirectory } from '../academic-setup/index.js';
import type { HolidayCalendar } from '../events/index.js';
import type { AttendanceStaff } from './attendance-staff.js';
import type { AttendanceRepository, SessionRow } from './attendance.repository.js';
import { AttendanceService } from './attendance.service.js';
import type { RosterStudent, SectionRoster } from './section-roster.js';

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

const tenant: TenantContext = {
  personId: 'person-1',
  roleCode: 3,
  societyId: 'society-1',
  institutionIds: ['inst-1'],
};
const context: InstitutionContext = {
  institutionId: 'inst-1',
  societyId: 'society-1',
  tenant,
};

const student = (id: string, roll: string): RosterStudent => ({
  studentId: `student-${id}`,
  studentEnrolmentId: `enrolment-${id}`,
  rollNumber: roll,
  firstName: `First${id}`,
  lastName: null,
  photoFileId: null,
});
const students = [student('1', '1'), student('2', '2'), student('3', '3')];

const session = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: 'session-1',
  created_at: new Date('2026-11-17T04:00:00.000Z'),
  created_by: 'person-1',
  updated_at: new Date('2026-11-17T04:00:00.000Z'),
  updated_by: 'person-1',
  version: 1,
  status: 1,
  society_id: 'society-1',
  institution_id: 'inst-1',
  academic_year_id: 'year-1',
  section_id: 'section-1',
  attendance_date: '2026-11-17',
  attendance_mode: 2,
  time_slot_id: null,
  subject_id: null,
  taken_by_staff_member_id: null,
  roster_count: 3,
  absent_count: 1,
  late_count: 0,
  half_day_count: 0,
  leave_count: 0,
  present_count: 2,
  submitted_at: new Date('2026-11-17T04:00:00.000Z'),
  submitted_by: 'person-1',
  last_corrected_at: null,
  last_corrected_by: null,
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
        details: error.options.details,
      };
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

const submission = {
  sectionId: 'section-1',
  attendanceDate: '2026-11-17',
  rosterCount: 3,
  exceptions: [{ studentEnrolmentId: 'enrolment-2', attendanceStatus: 2 }],
};

function build() {
  const tx = {} as Tx;
  const database = {
    transaction: vi.fn<DatabaseService['transaction']>((_tenant, work) => work(tx)),
  };
  const repository = {
    findActive: vi.fn<AttendanceRepository['findActive']>().mockResolvedValue(undefined),
    find: vi.fn<AttendanceRepository['find']>().mockResolvedValue(session()),
    list: vi.fn<AttendanceRepository['list']>().mockResolvedValue([session()]),
    insert: vi.fn<AttendanceRepository['insert']>().mockResolvedValue(session()),
    insertExceptions: vi.fn<AttendanceRepository['insertExceptions']>().mockResolvedValue(),
    exceptionsOf: vi.fn<AttendanceRepository['exceptionsOf']>().mockResolvedValue([]),
    findAny: vi.fn<AttendanceRepository['findAny']>().mockResolvedValue(session()),
    lockAny: vi.fn<AttendanceRepository['lockAny']>().mockResolvedValue(session()),
    update: vi
      .fn<AttendanceRepository['update']>()
      .mockImplementation((_tx, _id, changes) => Promise.resolve(session(changes as never))),
    setStatus: vi.fn<AttendanceRepository['setStatus']>().mockResolvedValue(),
    removeExceptions: vi.fn<AttendanceRepository['removeExceptions']>().mockResolvedValue(),
  };
  const scope = {
    forPrincipal: vi.fn<ScopeService['forPrincipal']>().mockResolvedValue({ tenant } as never),
    requireInstitution: vi.fn<ScopeService['requireInstitution']>().mockResolvedValue(context),
  };
  const years = {
    requireCurrentId: vi
      .fn<AcademicYearDirectory['requireCurrentId']>()
      .mockResolvedValue('year-1'),
    openYear: vi
      .fn<AcademicYearDirectory['openYear']>()
      .mockResolvedValue({ open: true, startDate: '2026-06-01', endDate: '2027-03-31' }),
  };
  const sections = {
    contextOf: vi.fn<SectionDirectory['contextOf']>().mockResolvedValue(context),
    placeOf: vi.fn<SectionDirectory['placeOf']>().mockResolvedValue({
      classId: 'class-1',
      institutionId: 'inst-1',
      active: true,
      capacity: null,
    }),
    names: vi
      .fn<SectionDirectory['names']>()
      .mockResolvedValue(
        new Map([['section-1', { displayName: 'A', classId: 'class-1', className: '10th' }]]),
      ),
  };
  const holidays = {
    forClass: vi.fn<HolidayCalendar['forClass']>().mockResolvedValue(undefined),
  };
  const roster = {
    on: vi.fn<SectionRoster['on']>().mockResolvedValue(students),
    studentsOf: vi
      .fn<SectionRoster['studentsOf']>()
      .mockResolvedValue(
        new Map([['enrolment-2', { studentId: 'student-2', firstName: 'First2', lastName: null }]]),
      ),
    guardiansOf: vi
      .fn<SectionRoster['guardiansOf']>()
      .mockResolvedValue(new Map([['enrolment-2', ['guardian-1', 'guardian-2']]])),
  };
  const staff = {
    ownRecord: vi
      .fn<AttendanceStaff['ownRecord']>()
      .mockResolvedValue({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-1' }),
  };
  const people = {
    describe: vi
      .fn<PersonDirectory['describe']>()
      .mockResolvedValue(
        new Map([['person-1', { id: 'person-1', displayName: 'R. Nair', roleName: null }]]),
      ),
  };
  const idempotency = {
    run: vi.fn<
      (
        call: unknown,
        work: (tx: Tx) => Promise<{ result: ApiResult<unknown> }>,
      ) => Promise<ApiResult<unknown>>
    >(async (_call, work) => (await work(tx)).result),
  };
  const notifications = { notify: vi.fn<Notifications['notify']>().mockResolvedValue('job-1') };
  const audit = { record: vi.fn<AuditService['record']>().mockResolvedValue('audit-1') };
  const clock = new FixedClock('2026-11-17T06:00:00.000Z');
  const service = new AttendanceService(
    database as unknown as DatabaseService,
    repository as unknown as AttendanceRepository,
    scope as unknown as ScopeService,
    years as unknown as AcademicYearDirectory,
    sections as unknown as SectionDirectory,
    holidays as unknown as HolidayCalendar,
    roster as unknown as SectionRoster,
    staff as unknown as AttendanceStaff,
    people as unknown as PersonDirectory,
    idempotency as unknown as IdempotencyService,
    notifications as unknown as Notifications,
    audit as unknown as AuditService,
    clock,
  );
  return {
    service,
    repository,
    scope,
    years,
    sections,
    holidays,
    roster,
    staff,
    idempotency,
    notifications,
    audit,
  };
}

describe('AttendanceService.submit', () => {
  it('stores the session with its counts and the marks, audits it, and says how many students', async () => {
    const { service, repository, audit } = build();
    const result = await service.submit(admin, 'key-1', submission);
    expect(result.options).toMatchObject({
      status: 201,
      code: 'ATTENDANCE_SUBMITTED',
      message: 'Attendance submitted for 3 students',
    });
    expect(repository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        section_id: 'section-1',
        attendance_date: '2026-11-17',
        roster_count: 3,
        absent_count: 1,
        late_count: 0,
        submitted_by: 'person-1',
        taken_by_staff_member_id: 'staff-1',
      }),
    );
    expect(repository.insertExceptions).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        attendance_session_id: 'session-1',
        student_enrolment_id: 'enrolment-2',
        attendance_status: 2,
      }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'attendance.submitted', entityId: 'session-1' }),
    );
  });

  it('records no teacher for an admin whose staff record is at another Institution', async () => {
    const { service, repository, staff } = build();
    staff.ownRecord.mockResolvedValue({ staffMemberId: 'staff-9', homeInstitutionId: 'inst-2' });
    await service.submit(admin, 'key-1', submission);
    expect(repository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taken_by_staff_member_id: null }),
    );
  });

  it('alerts the guardians of each Absent student and no one for Late, Half day or Leave', async () => {
    const { service, notifications } = build();
    await service.submit(admin, 'key-1', {
      ...submission,
      exceptions: [
        { studentEnrolmentId: 'enrolment-2', attendanceStatus: 2 },
        { studentEnrolmentId: 'enrolment-3', attendanceStatus: 3 },
      ],
    });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'absent:session-1:enrolment-2',
        category: 1,
        tab: 1,
        title: 'Marked absent',
        body: 'First2 was marked absent on 17 Nov 2026.',
        target: { type: 1, id: 'session-1' },
        receivers: [
          { userId: 'guardian-1', studentId: 'student-2' },
          { userId: 'guardian-2', studentId: 'student-2' },
        ],
      }),
      'person-1',
    );
  });

  it('sends no alert when no one is Absent', async () => {
    const { service, notifications, roster } = build();
    await service.submit(admin, 'key-1', { ...submission, exceptions: [] });
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(roster.guardiansOf).not.toHaveBeenCalled();
  });

  it('refuses a teacher away from their home Institution, 403 NOT_ASSIGNED', async () => {
    const { service, staff, repository } = build();
    staff.ownRecord.mockResolvedValue({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-2' });
    expect(await refusal(service.submit(teacher, 'key-1', submission))).toMatchObject({
      status: 403,
      code: 'NOT_ASSIGNED',
    });
    staff.ownRecord.mockResolvedValue(undefined);
    expect(await refusal(service.submit(teacher, 'key-1', submission))).toMatchObject({
      code: 'NOT_ASSIGNED',
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('lets a teacher mark at their home Institution', async () => {
    const { service, repository } = build();
    await service.submit(teacher, 'key-1', submission);
    expect(repository.insert).toHaveBeenCalled();
  });

  it('refuses a day that has not come, and a day outside the current year, 422', async () => {
    const { service } = build();
    expect(
      await refusal(
        service.submit(admin, 'key-1', { ...submission, attendanceDate: '2026-11-18' }),
      ),
    ).toMatchObject({ status: 422, code: 'DATE_IN_FUTURE' });
    expect(
      await refusal(
        service.submit(admin, 'key-1', { ...submission, attendanceDate: '2026-05-31' }),
      ),
    ).toMatchObject({ status: 422, code: 'DATE_OUTSIDE_CURRENT_YEAR' });
  });

  it('refuses a holiday of the section’s class, 422 DATE_IS_HOLIDAY', async () => {
    const { service, holidays } = build();
    holidays.forClass.mockResolvedValue({ eventId: 'event-1', title: 'Diwali' });
    expect(await refusal(service.submit(admin, 'key-1', submission))).toMatchObject({
      status: 422,
      code: 'DATE_IS_HOLIDAY',
    });
    expect(holidays.forClass).toHaveBeenCalledWith(
      expect.anything(),
      'inst-1',
      'class-1',
      '2026-11-17',
    );
  });

  it('refuses a second submission with the first one’s ID, 409', async () => {
    const { service, repository } = build();
    repository.findActive.mockResolvedValue(session({ id: 'session-first' }));
    expect(await refusal(service.submit(admin, 'key-1', submission))).toMatchObject({
      status: 409,
      code: 'ATTENDANCE_ALREADY_SUBMITTED',
      details: { sessionId: 'session-first' },
    });
  });

  it('answers the 409 of a race with the session that won', async () => {
    const { service, repository, idempotency } = build();
    idempotency.run.mockRejectedValue(
      Object.assign(new Error('duplicate'), {
        code: '23505',
        constraint: 'uq_attendance_sessions_daily',
      }),
    );
    repository.findActive.mockResolvedValue(session({ id: 'session-won' }));
    expect(await refusal(service.submit(admin, 'key-1', submission))).toMatchObject({
      status: 409,
      code: 'ATTENDANCE_ALREADY_SUBMITTED',
      details: { sessionId: 'session-won' },
    });
  });

  it('lets any other failure through', async () => {
    const { service, idempotency } = build();
    idempotency.run.mockRejectedValue(new Error('boom'));
    await expect(service.submit(admin, 'key-1', submission)).rejects.toThrow('boom');
  });

  it('refuses a roster that changed since the screen loaded, naming the count, 409', async () => {
    const { service } = build();
    expect(
      await refusal(service.submit(admin, 'key-1', { ...submission, rosterCount: 4 })),
    ).toMatchObject({ status: 409, code: 'ROSTER_CHANGED', details: { rosterCount: 3 } });
  });

  it('refuses a student who is not in the section on that day, 422 on the mark', async () => {
    const { service } = build();
    expect(
      await refusal(
        service.submit(admin, 'key-1', {
          ...submission,
          exceptions: [
            { studentEnrolmentId: 'enrolment-1', attendanceStatus: 3 },
            { studentEnrolmentId: 'enrolment-9', attendanceStatus: 2 },
          ],
        }),
      ),
    ).toMatchObject({
      status: 422,
      code: 'STUDENT_NOT_IN_SECTION',
      fields: ['exceptions[1].studentEnrolmentId'],
    });
  });

  it('refuses a student named twice before it reads anything', async () => {
    const { service, scope } = build();
    expect(
      await refusal(
        service.submit(admin, 'key-1', {
          ...submission,
          exceptions: [
            { studentEnrolmentId: 'enrolment-2', attendanceStatus: 2 },
            { studentEnrolmentId: 'enrolment-2', attendanceStatus: 3 },
          ],
        }),
      ),
    ).toMatchObject({ status: 400, fields: ['exceptions[1].studentEnrolmentId'] });
    expect(scope.forPrincipal).not.toHaveBeenCalled();
  });

  it('is 404 for a section out of reach and 422 for one that is deactivated', async () => {
    const { service, sections } = build();
    sections.contextOf.mockRejectedValue(AppException.notFound());
    expect(await refusal(service.submit(admin, 'key-1', submission))).toMatchObject({
      status: 404,
    });
    sections.contextOf.mockResolvedValue(context);
    sections.placeOf.mockResolvedValue({
      classId: 'class-1',
      institutionId: 'inst-1',
      active: false,
      capacity: null,
    });
    expect(await refusal(service.submit(admin, 'key-1', submission))).toMatchObject({
      status: 422,
      code: 'REFERENCE_INACTIVE',
      fields: ['sectionId'],
    });
  });

  it('keys the stored answer to the person and the whole body', async () => {
    const { service, idempotency } = build();
    await service.submit(admin, 'key-1', submission);
    expect(idempotency.run).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'key-1',
        operation: 'attendance.submit',
        request: submission,
        tenant: expect.objectContaining({ personId: 'person-1' }),
      }),
      expect.any(Function),
    );
  });
});

describe('AttendanceService.rosterOf', () => {
  const query = { sectionId: 'section-1', date: '2026-11-17' };

  it('lists everyone Present when no session was submitted, and says the caller may mark', async () => {
    const { service } = build();
    const roster = await service.rosterOf(admin, query);
    expect(roster).toMatchObject({
      section: { id: 'section-1', displayName: 'A', className: '10th' },
      date: '2026-11-17',
      isHoliday: false,
      holidayTitle: null,
      canMark: true,
      existingSession: null,
    });
    expect(roster.students.map((s) => [s.rollNumber, s.attendanceStatus])).toEqual([
      ['1', 1],
      ['2', 1],
      ['3', 1],
    ]);
  });

  it('shows the marks of a session already submitted, who submitted it, and cannot be marked again', async () => {
    const { service, repository, roster } = build();
    repository.findActive.mockResolvedValue(session());
    repository.exceptionsOf.mockResolvedValue([
      {
        attendance_session_id: 'session-1',
        student_enrolment_id: 'enrolment-2',
        attendance_date: '2026-11-17',
        institution_id: 'inst-1',
        attendance_status: 4,
        corrected_at: null,
        corrected_by: null,
      },
    ]);
    const shown = await service.rosterOf(admin, query);
    expect(shown.canMark).toBe(false);
    expect(shown.existingSession).toEqual({
      id: 'session-1',
      version: 1,
      submittedBy: { id: 'person-1', displayName: 'R. Nair' },
      submittedAt: '2026-11-17T04:00:00.000Z',
    });
    expect(shown.students.map((s) => s.attendanceStatus)).toEqual([1, 4, 1]);
    expect(roster.on).toHaveBeenCalledWith(
      expect.anything(),
      'section-1',
      '2026-11-17',
      new Date('2026-11-17T04:00:00.000Z'),
    );
  });

  it.each([
    ['a day that has not come', { date: '2026-11-18' }],
    ['a day outside the year', { date: '2026-05-01' }],
  ])('still loads %s, but cannot be marked', async (_name, change) => {
    const { service } = build();
    expect((await service.rosterOf(admin, { ...query, ...change })).canMark).toBe(false);
  });

  it('names the holiday and cannot be marked on it', async () => {
    const { service, holidays } = build();
    holidays.forClass.mockResolvedValue({ eventId: 'event-1', title: 'Diwali' });
    expect(await service.rosterOf(admin, query)).toMatchObject({
      isHoliday: true,
      holidayTitle: 'Diwali',
      canMark: false,
    });
  });

  it('lets a teacher read at an extra Institution but not mark there', async () => {
    const { service, staff } = build();
    staff.ownRecord.mockResolvedValue({ staffMemberId: 'staff-1', homeInstitutionId: 'inst-2' });
    expect((await service.rosterOf(teacher, query)).canMark).toBe(false);
  });

  it('cannot be marked for a section that is deactivated', async () => {
    const { service, sections } = build();
    sections.placeOf.mockResolvedValue({
      classId: 'class-1',
      institutionId: 'inst-1',
      active: false,
      capacity: null,
    });
    expect((await service.rosterOf(admin, query)).canMark).toBe(false);
  });

  it('is 404 for a section out of reach, and 422 CURRENT_YEAR_REQUIRED without a current year', async () => {
    const { service, sections, years } = build();
    sections.contextOf.mockRejectedValue(AppException.notFound());
    expect(await refusal(service.rosterOf(admin, query))).toMatchObject({ status: 404 });
    sections.contextOf.mockResolvedValue(context);
    years.requireCurrentId.mockRejectedValue(AppException.businessRule('CURRENT_YEAR_REQUIRED'));
    expect(await refusal(service.rosterOf(admin, query))).toMatchObject({
      status: 422,
      code: 'CURRENT_YEAR_REQUIRED',
    });
  });
});

describe('AttendanceService.list', () => {
  it('lists a section’s sessions, or those of an Institution, and needs one of them', async () => {
    const { service, repository, scope } = build();
    const bySection = await service.list(admin, { date: '2026-11-17', sectionId: 'section-1' });
    expect(bySection.data).toHaveLength(1);
    expect(repository.list).toHaveBeenCalledWith(expect.anything(), {
      date: '2026-11-17',
      sectionId: 'section-1',
      institutionId: 'inst-1',
    });
    await service.list(admin, { date: '2026-11-17', institutionId: 'inst-1' });
    expect(scope.requireInstitution).toHaveBeenCalledWith(admin, 'inst-1');
    expect(await refusal(service.list(admin, { date: '2026-11-17' }))).toMatchObject({
      status: 400,
      fields: ['institutionId'],
    });
    expect(
      await refusal(
        service.list(admin, {
          date: '2026-11-17',
          sectionId: 'section-1',
          institutionId: 'inst-1',
        }),
      ),
    ).toMatchObject({ status: 400, fields: ['institutionId'] });
  });
});

describe('AttendanceService.get', () => {
  it('shows a session with the students who were not Present', async () => {
    const { service, repository } = build();
    repository.exceptionsOf.mockResolvedValue([
      {
        attendance_session_id: 'session-1',
        student_enrolment_id: 'enrolment-2',
        attendance_date: '2026-11-17',
        institution_id: 'inst-1',
        attendance_status: 2,
        corrected_at: null,
        corrected_by: null,
      },
    ]);
    expect(await service.get(admin, 'session-1')).toMatchObject({
      id: 'session-1',
      sectionName: 'A',
      className: '10th',
      absentCount: 1,
      presentCount: 2,
      marks: [
        {
          studentEnrolmentId: 'enrolment-2',
          studentId: 'student-2',
          firstName: 'First2',
          lastName: null,
          attendanceStatus: 2,
        },
      ],
    });
  });

  it('is 404 for a session out of reach or voided', async () => {
    const { service, repository } = build();
    repository.find.mockResolvedValue(undefined);
    expect(await refusal(service.get(admin, 'session-1'))).toMatchObject({ status: 404 });
  });
});

const mark = (enrolmentId: string, status: number) => ({
  attendance_session_id: 'session-1',
  student_enrolment_id: enrolmentId,
  attendance_date: '2026-11-17',
  institution_id: 'inst-1',
  attendance_status: status,
  corrected_at: null,
  corrected_by: null,
});

const change = (enrolment: string, attendanceStatus: number) => ({
  studentEnrolmentId: `enrolment-${enrolment}`,
  attendanceStatus,
});

describe('AttendanceService.correct', () => {
  const stored = [mark('enrolment-2', 2), mark('enrolment-3', 3)];

  function withMarks() {
    const t = build();
    t.repository.exceptionsOf.mockResolvedValue(stored);
    return t;
  }

  it('adds, changes and removes marks, then the counts, the audit and the alert follow', async () => {
    const t = withMarks();
    const result = await t.service.correct(admin, 'session-1', {
      version: 1,
      changes: [change('1', 2), change('2', 5), change('3', 1)],
    });
    expect(t.repository.lockAny).toHaveBeenCalledWith(expect.anything(), 'session-1');
    expect(t.repository.insertExceptions).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        student_enrolment_id: 'enrolment-1',
        attendance_status: 2,
        corrected_by: 'person-1',
      }),
    ]);
    expect(t.repository.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      '2026-11-17',
      'enrolment-2',
      5,
      { at: new Date('2026-11-17T06:00:00.000Z'), by: 'person-1' },
    );
    expect(t.repository.removeExceptions).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      '2026-11-17',
      ['enrolment-3'],
    );
    expect(t.repository.update).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      expect.objectContaining({
        absent_count: 1,
        late_count: 0,
        half_day_count: 0,
        leave_count: 1,
        last_corrected_by: 'person-1',
        updated_by: 'person-1',
      }),
    );
    expect(t.audit.record).toHaveBeenCalledTimes(1);
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'attendance.corrected',
        entityId: 'session-1',
        before: { marks: { 'enrolment-1': 1, 'enrolment-2': 2, 'enrolment-3': 3 } },
        after: { marks: { 'enrolment-1': 2, 'enrolment-2': 5, 'enrolment-3': 1 } },
      }),
    );
    expect(result).toMatchObject({ id: 'session-1', absentCount: 1, leaveCount: 1 });
  });

  it('alerts the guardians of a student who becomes Absent, and of no one who stops being Absent', async () => {
    const t = withMarks();
    t.roster.studentsOf.mockResolvedValue(
      new Map([['enrolment-1', { studentId: 'student-1', firstName: 'First1', lastName: null }]]),
    );
    t.roster.guardiansOf.mockResolvedValue(new Map([['enrolment-1', ['guardian-1']]]));
    await t.service.correct(admin, 'session-1', {
      version: 1,
      changes: [change('1', 2), change('2', 1)],
    });
    expect(t.roster.studentsOf).toHaveBeenCalledWith(expect.anything(), ['enrolment-1']);
    expect(t.notifications.notify).toHaveBeenCalledTimes(1);
    expect(t.notifications.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'absent:session-1:enrolment-1',
        // dated by the submission, as the first alert is, so the inbox tells a child Absent again once (QA B7 D1)
        occurredAt: new Date('2026-11-17T04:00:00.000Z'),
        receivers: [{ userId: 'guardian-1', studentId: 'student-1' }],
      }),
      'person-1',
    );

    const away = withMarks();
    await away.service.correct(admin, 'session-1', { version: 1, changes: [change('2', 1)] });
    expect(away.notifications.notify).not.toHaveBeenCalled();
  });

  it('writes nothing for a request that changes nothing', async () => {
    const t = withMarks();
    const result = await t.service.correct(admin, 'session-1', {
      version: 1,
      changes: [change('2', 2), change('1', 1)],
    });
    expect(t.repository.update).not.toHaveBeenCalled();
    expect(t.repository.insertExceptions).not.toHaveBeenCalled();
    expect(t.audit.record).not.toHaveBeenCalled();
    expect(result.version).toBe(1);
  });

  it('says the version first (409), then that the session is void (409)', async () => {
    const t = withMarks();
    t.repository.lockAny.mockResolvedValue(session({ version: 3, status: 0 }));
    expect(
      await refusal(
        t.service.correct(admin, 'session-1', { version: 2, changes: [change('1', 2)] }),
      ),
    ).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: { currentVersion: 3 } });
    expect(
      await refusal(
        t.service.correct(admin, 'session-1', { version: 3, changes: [change('1', 2)] }),
      ),
    ).toMatchObject({ status: 409, code: 'SESSION_VOIDED' });
    expect(t.repository.update).not.toHaveBeenCalled();
  });

  it('refuses a student named twice before it reads anything', async () => {
    const t = withMarks();
    expect(
      await refusal(
        t.service.correct(admin, 'session-1', {
          version: 1,
          changes: [change('1', 2), change('1', 3)],
        }),
      ),
    ).toMatchObject({ status: 400, fields: ['changes[1].studentEnrolmentId'] });
    expect(t.scope.forPrincipal).not.toHaveBeenCalled();
  });

  it('refuses a student who is not in the section, naming each, writing nothing', async () => {
    const t = withMarks();
    expect(
      await refusal(
        t.service.correct(admin, 'session-1', {
          version: 1,
          changes: [change('1', 2), change('9', 2), change('8', 3)],
        }),
      ),
    ).toMatchObject({
      status: 422,
      code: 'STUDENT_NOT_IN_SECTION',
      fields: ['changes[1].studentEnrolmentId', 'changes[2].studentEnrolmentId'],
    });
    expect(t.repository.update).not.toHaveBeenCalled();
  });

  it('refuses a teacher away from their home Institution, 403 NOT_ASSIGNED', async () => {
    const t = withMarks();
    t.staff.ownRecord.mockResolvedValue({ staffMemberId: 'staff-9', homeInstitutionId: 'inst-2' });
    expect(
      await refusal(
        t.service.correct(teacher, 'session-1', { version: 1, changes: [change('1', 2)] }),
      ),
    ).toMatchObject({ status: 403, code: 'NOT_ASSIGNED' });
  });

  it('lets a teacher correct this year only, and an admin any year', async () => {
    const past = session({ academic_year_id: 'year-0' });
    const t = withMarks();
    t.repository.lockAny.mockResolvedValue(past);
    expect(
      await refusal(
        t.service.correct(teacher, 'session-1', { version: 1, changes: [change('1', 2)] }),
      ),
    ).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(t.years.requireCurrentId).toHaveBeenCalledWith(expect.anything(), 'inst-1');
    await t.service.correct(admin, 'session-1', { version: 1, changes: [change('1', 2)] });
    expect(t.repository.update).toHaveBeenCalledTimes(1);
    const current = withMarks();
    await current.service.correct(teacher, 'session-1', { version: 1, changes: [change('1', 2)] });
    expect(current.repository.update).toHaveBeenCalledTimes(1);
  });

  it('is 404 for a session that is not there or out of the caller’s reach', async () => {
    const t = withMarks();
    t.repository.findAny.mockResolvedValue(undefined);
    expect(
      await refusal(
        t.service.correct(admin, 'session-1', { version: 1, changes: [change('1', 2)] }),
      ),
    ).toMatchObject({ status: 404 });
    const out = withMarks();
    out.scope.requireInstitution.mockRejectedValue(AppException.notFound());
    expect(
      await refusal(
        out.service.correct(admin, 'session-1', { version: 1, changes: [change('1', 2)] }),
      ),
    ).toMatchObject({ status: 404 });
    const gone = withMarks();
    gone.repository.lockAny.mockResolvedValue(undefined);
    expect(
      await refusal(
        gone.service.correct(admin, 'session-1', { version: 1, changes: [change('1', 2)] }),
      ),
    ).toMatchObject({ status: 404 });
  });
});

describe('AttendanceService.voidSession', () => {
  const reason = 'Marked the wrong section';

  it('voids the session, audits the reason, and says so', async () => {
    const t = build();
    expect(await t.service.voidSession(admin, 'session-1', { version: 1, reason })).toEqual({
      id: 'session-1',
      status: 0,
    });
    expect(t.repository.update).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      expect.objectContaining({ status: 0, updated_by: 'person-1' }),
    );
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'attendance.voided',
        entityId: 'session-1',
        institutionId: 'inst-1',
        reason,
        before: { status: 1 },
        after: { status: 0 },
      }),
    );
    expect(t.notifications.notify).not.toHaveBeenCalled();
  });

  it('says the version first (409), then that it is void already (409)', async () => {
    const t = build();
    t.repository.lockAny.mockResolvedValue(session({ version: 2, status: 0 }));
    expect(
      await refusal(t.service.voidSession(admin, 'session-1', { version: 1, reason })),
    ).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: { currentVersion: 2 } });
    expect(
      await refusal(t.service.voidSession(admin, 'session-1', { version: 2, reason })),
    ).toMatchObject({ status: 409, code: 'SESSION_VOIDED' });
    expect(t.repository.update).not.toHaveBeenCalled();
  });

  it('is 404 for a session that is not there or out of reach', async () => {
    const t = build();
    t.repository.findAny.mockResolvedValue(undefined);
    expect(
      await refusal(t.service.voidSession(admin, 'session-1', { version: 1, reason })),
    ).toMatchObject({ status: 404 });
    const out = build();
    out.scope.requireInstitution.mockRejectedValue(AppException.notFound());
    expect(
      await refusal(out.service.voidSession(admin, 'session-1', { version: 1, reason })),
    ).toMatchObject({ status: 404 });
  });
});
