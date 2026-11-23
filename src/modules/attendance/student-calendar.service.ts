import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { Clock } from '../../common/time/clock.js';
import { monthSpan } from '../../common/time/calendar-days.js';
import { DatabaseService, type Tx } from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { AcademicYearDirectory, SectionDirectory } from '../academic-setup/index.js';
import { HolidayCalendar } from '../events/index.js';
import {
  daysOf,
  markKey,
  sessionKey,
  tally,
  dayOf,
  type CalendarInputs,
} from './attendance-calendar.rules.js';
import { AttendanceRepository } from './attendance.repository.js';
import type { CalendarQueryDto } from './student-calendar.dto.js';
import {
  calendarResource,
  dayResource,
  type StudentCalendarResource,
  type StudentDayResource,
} from './student-calendar.resource.js';
import { StudentAttendanceAccess, type PlacementSpan } from './student-attendance-access.js';

interface Year {
  startDate: string;
  endDate: string;
}

/**
 * ATT-07 and ATT-08 (API design 10.13): a student's attendance as a calendar and a day. Every day is told from where
 * the student sat, the sessions of those sections and the exceptions against the student (DDD 13.2): nothing is stored
 * per student per day. Who may read it, and in which context, is People's to say (`StudentAttendanceAccess`).
 */
@Injectable()
export class StudentCalendarService {
  constructor(
    private readonly access: StudentAttendanceAccess,
    private readonly database: DatabaseService,
    private readonly attendance: AttendanceRepository,
    private readonly years: AcademicYearDirectory,
    private readonly sections: SectionDirectory,
    private readonly holidays: HolidayCalendar,
    private readonly people: PersonDirectory,
    private readonly clock: Clock,
  ) {}

  /** ATT-07: the month's days and counts, and the share attended from the year's start to today. */
  async month(
    principal: Principal,
    studentId: string,
    query: CalendarQueryDto,
  ): Promise<StudentCalendarResource> {
    const context = await this.access.contextOf(principal, studentId);
    const { from, to } = monthSpan(query.month);
    const today = this.clock.todayIst();
    return this.database.transaction(context.tenant, async (tx) => {
      const year = await this.requireYear(tx, context.institutionId, from, to);
      // The year to date ends today, or the year's last day; a month still to come shows its days without marks.
      const yearEnd = today < year.endDate ? today : year.endDate;
      const last = to > yearEnd ? to : yearEnd;
      const inputs = await this.inputs(tx, context.institutionId, studentId, year, last, {
        from,
        to,
      });
      const days = daysOf(from, to, inputs);
      const toDate = daysOf(year.startDate, yearEnd, inputs);
      return calendarResource(
        query.month,
        days,
        tally(days, today),
        tally(toDate, today).attendancePercentage,
      );
    });
  }

  /** ATT-08: one day, with the section the student sat in and who marked it. */
  async day(principal: Principal, studentId: string, date: string): Promise<StudentDayResource> {
    const context = await this.access.contextOf(principal, studentId);
    return this.database.transaction(context.tenant, async (tx) => {
      const year = await this.requireYear(tx, context.institutionId, date, date);
      const inputs = await this.inputs(tx, context.institutionId, studentId, year, date, {
        from: date,
        to: date,
      });
      const day = dayOf(date, inputs);
      const section = day.span
        ? (await this.sections.names(tx, [day.span.sectionId])).get(day.span.sectionId)
        : undefined;
      const people = await this.people.describe([day.session?.submittedBy ?? null]);
      return dayResource(day, section, people);
    });
  }

  /** The academic year of the Institution that holds the days, else 422 `OUTSIDE_ACADEMIC_YEAR`. */
  private async requireYear(
    tx: Tx,
    institutionId: string,
    from: string,
    to: string,
  ): Promise<Year> {
    const year = await this.years.overlapping(tx, institutionId, from, to);
    if (!year) throw AppException.businessRule(ErrorCode.OUTSIDE_ACADEMIC_YEAR);
    return year;
  }

  /**
   * What the days are told from: the placements, sessions and exceptions from the year's start to `last`, and the
   * holidays of the classes the student sat in during the `shown` days.
   */
  private async inputs(
    tx: Tx,
    institutionId: string,
    studentId: string,
    year: Year,
    last: string,
    shown: { from: string; to: string },
  ): Promise<CalendarInputs> {
    const end = last < year.endDate ? last : year.endDate;
    const spans = await this.access.placementsOf(tx, studentId, year.startDate, end);
    const sessions = await this.attendance.sessionsOfSections(
      tx,
      spans.map((span) => span.sectionId),
      year.startDate,
      end,
    );
    const marks = await this.attendance.marksOfEnrolments(
      tx,
      spans.map((span) => span.studentEnrolmentId),
      year.startDate,
      end,
    );
    return {
      year,
      spans,
      sessions: new Map(
        sessions.map((row) => [sessionKey(row.sectionId, row.attendanceDate), row]),
      ),
      marks: new Map(
        marks.map((row) => [
          markKey(row.studentEnrolmentId, row.attendanceDate),
          row.attendanceStatus,
        ]),
      ),
      holidays: await this.holidaysOf(tx, institutionId, spans, shown),
    };
  }

  /** The holidays, by class, of the classes the student sat in during the shown days. */
  private async holidaysOf(
    tx: Tx,
    institutionId: string,
    spans: readonly PlacementSpan[],
    shown: { from: string; to: string },
  ): Promise<Map<string, ReadonlyMap<string, string>>> {
    const classIds = new Set(
      spans
        .filter(
          (span) =>
            span.startDate <= shown.to && (span.endDate === null || span.endDate >= shown.from),
        )
        .map((span) => span.classId),
    );
    const holidays = new Map<string, ReadonlyMap<string, string>>();
    for (const classId of classIds) {
      holidays.set(
        classId,
        await this.holidays.between(tx, institutionId, classId, shown.from, shown.to),
      );
    }
    return holidays;
  }
}
