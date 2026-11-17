import type { PersonRef } from '../../platform/identity/index.js';
import type { DayStatus, DayView, Tally } from './attendance-calendar.rules.js';

/** One day of the month as the calendar draws it (API design 10.13). */
export interface CalendarDayResource {
  date: string;
  dayStatus: DayStatus;
  isWeekend: boolean;
  holidayTitle: string | null;
}

/** ATT-07: a student's month, the counts of it, and the share attended so far this year. */
export interface StudentCalendarResource {
  month: string;
  summary: Tally;
  yearToDate: { attendancePercentage: number | null };
  days: CalendarDayResource[];
}

/** ATT-08: one day of a student, and who marked it. */
export interface StudentDayResource extends CalendarDayResource {
  section: { id: string; name: string; className: string } | null;
  markedBy: { id: string; displayName: string } | null;
  markedAt: string | null;
  lastCorrectedAt: string | null;
}

export function calendarDay(day: DayView): CalendarDayResource {
  return {
    date: day.date,
    dayStatus: day.dayStatus,
    isWeekend: day.isWeekend,
    holidayTitle: day.holidayTitle,
  };
}

export function calendarResource(
  month: string,
  days: readonly DayView[],
  summary: Tally,
  yearToDate: number | null,
): StudentCalendarResource {
  return {
    month,
    summary,
    yearToDate: { attendancePercentage: yearToDate },
    days: days.map(calendarDay),
  };
}

export function dayResource(
  day: DayView,
  section: { displayName: string; className: string } | undefined,
  people: ReadonlyMap<string, PersonRef>,
): StudentDayResource {
  const submittedBy = day.session?.submittedBy;
  return {
    ...calendarDay(day),
    section:
      day.span && section
        ? { id: day.span.sectionId, name: section.displayName, className: section.className }
        : null,
    markedBy:
      submittedBy === undefined
        ? null
        : { id: submittedBy, displayName: people.get(submittedBy)?.displayName ?? 'Unknown' },
    markedAt: day.session?.submittedAt.toISOString() ?? null,
    lastCorrectedAt: day.session?.lastCorrectedAt?.toISOString() ?? null,
  };
}
