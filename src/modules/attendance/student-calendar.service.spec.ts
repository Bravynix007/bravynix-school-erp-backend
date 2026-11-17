import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { FixedClock } from '../../common/time/clock.js';
import type { DatabaseService, TenantContext, Tx } from '../../platform/database/index.js';
import type { PersonDirectory } from '../../platform/identity/index.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';
import type { AcademicYearDirectory, SectionDirectory } from '../academic-setup/index.js';
import type { HolidayCalendar } from '../events/index.js';
import type { AttendanceRepository } from './attendance.repository.js';
import type { PlacementSpan, StudentAttendanceAccess } from './student-attendance-access.js';
import { StudentCalendarService } from './student-calendar.service.js';

const principal = { personId: 'person-1', roleCode: 3 } as Principal;
const tenant: TenantContext = {
  personId: 'person-1',
  roleCode: 3,
  societyId: 'society-1',
  institutionIds: ['inst-1'],
};
const context: InstitutionContext = { institutionId: 'inst-1', societyId: 'society-1', tenant };
const year = { id: 'year-1', startDate: '2026-06-01', endDate: '2027-03-31' };
const span: PlacementSpan = {
  studentEnrolmentId: 'enrolment-1',
  sectionId: 'section-1',
  classId: 'class-1',
  startDate: '2026-11-02',
  endDate: null,
  placedAt: new Date('2026-11-02T04:00:00.000Z'),
};
const session = (date: string) => ({
  id: `session-${date}`,
  sectionId: 'section-1',
  attendanceDate: date,
  submittedAt: new Date(`${date}T04:30:00.000Z`),
  submittedBy: 'person-1',
  lastCorrectedAt: null,
});

function build(spans: PlacementSpan[] = [span]) {
  const tx = {} as Tx;
  const contextOf = vi.fn<StudentAttendanceAccess['contextOf']>().mockResolvedValue(context);
  const placementsOf = vi.fn<StudentAttendanceAccess['placementsOf']>().mockResolvedValue(spans);
  const overlapping = vi.fn<AcademicYearDirectory['overlapping']>().mockResolvedValue(year);
  const sessionsOfSections = vi
    .fn<AttendanceRepository['sessionsOfSections']>()
    .mockResolvedValue([session('2026-11-03'), session('2026-11-04')]);
  const marksOfEnrolments = vi
    .fn<AttendanceRepository['marksOfEnrolments']>()
    .mockResolvedValue([
      { studentEnrolmentId: 'enrolment-1', attendanceDate: '2026-11-03', attendanceStatus: 2 },
    ]);
  const between = vi
    .fn<HolidayCalendar['between']>()
    .mockResolvedValue(new Map([['2026-11-11', 'Founders Day']]));
  const names = vi
    .fn<SectionDirectory['names']>()
    .mockResolvedValue(
      new Map([['section-1', { displayName: 'A', classId: 'class-1', className: '10th' }]]),
    );
  const describe = vi
    .fn<PersonDirectory['describe']>()
    .mockResolvedValue(new Map([['person-1', { displayName: 'Anna Rao' }]]) as never);
  const service = new StudentCalendarService(
    { contextOf, placementsOf } as unknown as StudentAttendanceAccess,
    {
      transaction: (_tenant: TenantContext, work: (tx: Tx) => Promise<unknown>) => work(tx),
    } as unknown as DatabaseService,
    { sessionsOfSections, marksOfEnrolments } as unknown as AttendanceRepository,
    { overlapping } as unknown as AcademicYearDirectory,
    { names } as unknown as SectionDirectory,
    { between } as unknown as HolidayCalendar,
    { describe } as unknown as PersonDirectory,
    new FixedClock('2026-11-17T01:00:00.000Z'),
  );
  return {
    service,
    contextOf,
    placementsOf,
    overlapping,
    sessionsOfSections,
    marksOfEnrolments,
    between,
    names,
    describe,
  };
}

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return { status: error.status as number, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('StudentCalendarService.month', () => {
  it('reads the days of the month under the context People gave, from the year start to today', async () => {
    const t = build();
    const calendar = await t.service.month(principal, 'student-1', { month: '2026-11' });
    expect(t.contextOf).toHaveBeenCalledWith(principal, 'student-1');
    expect(t.overlapping).toHaveBeenCalledWith(
      expect.anything(),
      'inst-1',
      '2026-11-01',
      '2026-11-30',
    );
    expect(t.placementsOf).toHaveBeenCalledWith(
      expect.anything(),
      'student-1',
      '2026-06-01',
      '2026-11-30',
    );
    expect(t.sessionsOfSections).toHaveBeenCalledWith(
      expect.anything(),
      ['section-1'],
      '2026-06-01',
      '2026-11-30',
    );
    expect(t.marksOfEnrolments).toHaveBeenCalledWith(
      expect.anything(),
      ['enrolment-1'],
      '2026-06-01',
      '2026-11-30',
    );
    expect(t.between).toHaveBeenCalledWith(
      expect.anything(),
      'inst-1',
      'class-1',
      '2026-11-01',
      '2026-11-30',
    );
    expect(calendar.days).toHaveLength(30);
    expect(calendar.days.find((d) => d.date === '2026-11-11')).toMatchObject({
      dayStatus: 'holiday',
      holidayTitle: 'Founders Day',
    });
    expect(calendar.summary).toMatchObject({
      presentDays: 1,
      absentDays: 1,
      holidays: 1,
      attendancePercentage: 50,
    });
    expect(calendar.yearToDate.attendancePercentage).toBe(50);
  });

  it('reads no further than the year’s last day, and asks for the holidays of the classes of the month only', async () => {
    const t = build([
      { ...span, classId: 'class-old', endDate: '2026-10-31' },
      { ...span, startDate: '2026-11-01' },
    ]);
    await t.service.month(principal, 'student-1', { month: '2027-03' });
    expect(t.placementsOf).toHaveBeenCalledWith(
      expect.anything(),
      'student-1',
      '2026-06-01',
      '2027-03-31',
    );
    expect(t.between).toHaveBeenCalledTimes(1);
    expect(t.between).toHaveBeenCalledWith(
      expect.anything(),
      'inst-1',
      'class-1',
      '2027-03-01',
      '2027-03-31',
    );
  });

  it('has no percentage for a student with nothing marked', async () => {
    const t = build([]);
    t.sessionsOfSections.mockResolvedValue([]);
    const calendar = await t.service.month(principal, 'student-1', { month: '2026-11' });
    expect(calendar.summary.attendancePercentage).toBeNull();
    expect(calendar.yearToDate.attendancePercentage).toBeNull();
    expect(t.between).not.toHaveBeenCalled();
  });

  it('is 422 OUTSIDE_ACADEMIC_YEAR when no year holds the month', async () => {
    const t = build();
    t.overlapping.mockResolvedValue(undefined);
    expect(await refusal(t.service.month(principal, 'student-1', { month: '2025-01' }))).toEqual({
      status: 422,
      code: 'OUTSIDE_ACADEMIC_YEAR',
    });
  });

  it('refuses what People refuses, and reads nothing', async () => {
    const t = build();
    t.contextOf.mockRejectedValue(AppException.notFound());
    expect(
      (await refusal(t.service.month(principal, 'student-1', { month: '2026-11' }))).status,
    ).toBe(404);
    expect(t.overlapping).not.toHaveBeenCalled();
  });
});

describe('StudentCalendarService.day', () => {
  it('tells one day, with the section and who marked it', async () => {
    const t = build();
    const day = await t.service.day(principal, 'student-1', '2026-11-03');
    expect(t.overlapping).toHaveBeenCalledWith(
      expect.anything(),
      'inst-1',
      '2026-11-03',
      '2026-11-03',
    );
    expect(t.placementsOf).toHaveBeenCalledWith(
      expect.anything(),
      'student-1',
      '2026-06-01',
      '2026-11-03',
    );
    expect(t.names).toHaveBeenCalledWith(expect.anything(), ['section-1']);
    expect(t.describe).toHaveBeenCalledWith(['person-1']);
    expect(day).toMatchObject({
      date: '2026-11-03',
      dayStatus: 'absent',
      section: { id: 'section-1', name: 'A', className: '10th' },
      markedBy: { id: 'person-1', displayName: 'Anna Rao' },
    });
  });

  it('names no section for a day the student was not placed, and no marker for a day nobody marked', async () => {
    const t = build();
    const before = await t.service.day(principal, 'student-1', '2026-11-01');
    expect(before).toMatchObject({ dayStatus: 'not_enrolled', section: null, markedBy: null });
    expect(t.names).not.toHaveBeenCalled();
    const unmarked = await t.service.day(principal, 'student-1', '2026-11-09');
    expect(unmarked).toMatchObject({ dayStatus: 'not_marked', markedBy: null });
    expect(t.describe).toHaveBeenLastCalledWith([null]);
  });

  it('is 422 OUTSIDE_ACADEMIC_YEAR for a day no year holds', async () => {
    const t = build();
    t.overlapping.mockResolvedValue(undefined);
    expect(await refusal(t.service.day(principal, 'student-1', '2027-05-01'))).toEqual({
      status: 422,
      code: 'OUTSIDE_ACADEMIC_YEAR',
    });
  });
});
