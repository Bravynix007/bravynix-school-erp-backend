import { eachDay, isSunday } from '../../common/time/calendar-days.js';
import { AttendanceStatus } from './attendance.rules.js';
import type { PlacementSpan } from './student-attendance-access.js';

/** What a student's day was (API design 10.13). Strings, because a day's status is a computed view, not a stored code. */
export type DayStatus =
  'present' | 'absent' | 'late' | 'half_day' | 'leave' | 'holiday' | 'not_marked' | 'not_enrolled';

const MARK_STATUS: Record<number, DayStatus> = {
  [AttendanceStatus.Present]: 'present',
  [AttendanceStatus.Absent]: 'absent',
  [AttendanceStatus.Late]: 'late',
  [AttendanceStatus.HalfDay]: 'half_day',
  [AttendanceStatus.Leave]: 'leave',
};

/** A session of a section on a day, as a calendar needs it. */
export interface SessionFact {
  id: string;
  submittedAt: Date;
  submittedBy: string;
  lastCorrectedAt: Date | null;
}

/** Everything one student's days are told from. */
export interface CalendarInputs {
  year: { startDate: string; endDate: string };
  spans: readonly PlacementSpan[];
  /** The active sessions, by `sessionKey(sectionId, date)`. */
  sessions: ReadonlyMap<string, SessionFact>;
  /** The student's exceptions, by `markKey(studentEnrolmentId, date)`. */
  marks: ReadonlyMap<string, number>;
  /** The holidays for each class, by class ID and then date, with the title. */
  holidays: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** One day of the student, and what it was told from. */
export interface DayView {
  date: string;
  dayStatus: DayStatus;
  isWeekend: boolean;
  holidayTitle: string | null;
  span: PlacementSpan | undefined;
  session: SessionFact | undefined;
}

export const sessionKey = (sectionId: string, date: string): string => `${sectionId}|${date}`;
export const markKey = (studentEnrolmentId: string, date: string): string =>
  `${studentEnrolmentId}|${date}`;

function covering(spans: readonly PlacementSpan[], date: string): PlacementSpan | undefined {
  return spans.find(
    (span) => span.startDate <= date && (span.endDate === null || span.endDate >= date),
  );
}

/**
 * The day of a student (DDD 13.2). A day outside the academic year, or with no placement of the student, is not
 * enrolled. A section's session counts the student when the placement was made by the time it was submitted: then the
 * student was Present unless an exception says otherwise, and the mark wins over a holiday added since. Without a
 * session, a holiday of the class is a holiday and any other day is not marked (a Sunday is the weekly off, and says
 * so in `isWeekend`).
 */
export function dayOf(date: string, inputs: CalendarInputs): DayView {
  const isWeekend = isSunday(date);
  const span =
    date >= inputs.year.startDate && date <= inputs.year.endDate
      ? covering(inputs.spans, date)
      : undefined;
  if (!span) {
    return {
      date,
      dayStatus: 'not_enrolled',
      isWeekend,
      holidayTitle: null,
      span,
      session: undefined,
    };
  }
  const holidayTitle = inputs.holidays.get(span.classId)?.get(date) ?? null;
  const found = inputs.sessions.get(sessionKey(span.sectionId, date));
  const session = found && span.placedAt <= found.submittedAt ? found : undefined;
  if (session) {
    const mark = inputs.marks.get(markKey(span.studentEnrolmentId, date));
    const dayStatus = MARK_STATUS[mark ?? AttendanceStatus.Present]!;
    return { date, dayStatus, isWeekend, holidayTitle, span, session };
  }
  return {
    date,
    dayStatus: holidayTitle === null ? 'not_marked' : 'holiday',
    isWeekend,
    holidayTitle,
    span,
    session: undefined,
  };
}

/** How many days of each kind a stretch had, and the share attended. */
export interface Tally {
  presentDays: number;
  absentDays: number;
  lateDays: number;
  halfDays: number;
  leaveDays: number;
  holidays: number;
  notMarkedDays: number;
  /** Present and Late count as attended, Half day as half; over the days marked. `null` when none was. */
  attendancePercentage: number | null;
}

/** The share attended: (Present + Late + half of Half day) over every day marked, to two decimals. */
export function attendancePercentage(counts: {
  presentDays: number;
  absentDays: number;
  lateDays: number;
  halfDays: number;
  leaveDays: number;
}): number | null {
  const marked =
    counts.presentDays + counts.absentDays + counts.lateDays + counts.halfDays + counts.leaveDays;
  if (marked === 0) return null;
  const attended = counts.presentDays + counts.lateDays + counts.halfDays / 2;
  return Math.round((attended / marked) * 10_000) / 100;
}

/**
 * The tally of days. A day not marked counts only when it is a school day that has come (not a Sunday, not after
 * `today`): the days still to come are not missing.
 */
export function tally(days: readonly DayView[], today: string): Tally {
  const counts = {
    presentDays: 0,
    absentDays: 0,
    lateDays: 0,
    halfDays: 0,
    leaveDays: 0,
    holidays: 0,
    notMarkedDays: 0,
  };
  for (const day of days) {
    if (day.dayStatus === 'present') counts.presentDays += 1;
    else if (day.dayStatus === 'absent') counts.absentDays += 1;
    else if (day.dayStatus === 'late') counts.lateDays += 1;
    else if (day.dayStatus === 'half_day') counts.halfDays += 1;
    else if (day.dayStatus === 'leave') counts.leaveDays += 1;
    else if (day.dayStatus === 'holiday') counts.holidays += 1;
    else if (day.dayStatus === 'not_marked' && !day.isWeekend && day.date <= today) {
      counts.notMarkedDays += 1;
    }
  }
  return { ...counts, attendancePercentage: attendancePercentage(counts) };
}

/** The days from `from` to `to`, each told from the inputs. */
export function daysOf(from: string, to: string, inputs: CalendarInputs): DayView[] {
  return eachDay(from, to).map((date) => dayOf(date, inputs));
}
