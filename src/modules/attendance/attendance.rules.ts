import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode, FieldErrorCode } from '../../common/http/error-codes.js';
import type { FieldError } from '../../common/http/field-error.type.js';
import { fieldError } from '../../common/validation/field-error.js';

/** What a student's day can be marked (API design 9.7, DDD M3). Present is never stored: an unmarked student was Present. */
export const AttendanceStatus = { Present: 1, Absent: 2, Late: 3, HalfDay: 4, Leave: 5 } as const;

/** The statuses a correction may name: Present too, which takes the exception away. */
export const ALL_STATUSES = [1, 2, 3, 4, 5] as const;

/** The statuses a submission may send: every one but Present. */
export const EXCEPTION_STATUSES = [2, 3, 4, 5] as const;

/** The marks a session counts. */
export interface MarkCounts {
  absent: number;
  late: number;
  halfDay: number;
  leave: number;
}

/** How many students were marked with each status. */
export function countMarks(marks: readonly { attendanceStatus: number }[]): MarkCounts {
  const counts: MarkCounts = { absent: 0, late: 0, halfDay: 0, leave: 0 };
  for (const mark of marks) {
    if (mark.attendanceStatus === AttendanceStatus.Absent) counts.absent += 1;
    else if (mark.attendanceStatus === AttendanceStatus.Late) counts.late += 1;
    else if (mark.attendanceStatus === AttendanceStatus.HalfDay) counts.halfDay += 1;
    else counts.leave += 1;
  }
  return counts;
}

/** A student named twice is 400 `INVALID_VALUE` on the second mention, in the list called `field`. */
export function requireEachStudentOnce(
  marks: readonly { studentEnrolmentId: string }[],
  field = 'exceptions',
): void {
  const seen = new Set<string>();
  const errors: FieldError[] = [];
  marks.forEach((mark, index) => {
    if (seen.has(mark.studentEnrolmentId)) {
      errors.push(
        fieldError(
          `${field}[${index.toString()}].studentEnrolmentId`,
          FieldErrorCode.INVALID_VALUE,
        ),
      );
    }
    seen.add(mark.studentEnrolmentId);
  });
  if (errors.length > 0) throw AppException.validation(errors);
}

/** The first and last day of the current academic year, as the date rules need them. */
export interface YearSpan {
  startDate: string;
  endDate: string;
}

/**
 * The date rules of a submission, in their order (API design 10.11): the day has come (422 `DATE_IN_FUTURE`, by the
 * IST calendar, as for the whole product), and it is in the Institution's current year (422
 * `DATE_OUTSIDE_CURRENT_YEAR`). `undefined` when the date can be marked. Dates are `YYYY-MM-DD`, so they compare as text.
 */
export function dateRefusal(
  date: string,
  today: string,
  year: YearSpan,
): 'DATE_IN_FUTURE' | 'DATE_OUTSIDE_CURRENT_YEAR' | undefined {
  if (date > today) return ErrorCode.DATE_IN_FUTURE;
  if (date < year.startDate || date > year.endDate) return ErrorCode.DATE_OUTSIDE_CURRENT_YEAR;
  return undefined;
}

export function requireMarkableDate(date: string, today: string, year: YearSpan): void {
  const refusal = dateRefusal(date, today, year);
  if (refusal !== undefined) throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, refusal);
}

/** One student whose mark a correction really changes. */
interface MarkChange {
  studentEnrolmentId: string;
  before: number;
  after: number;
}

/** What a correction does to the marks of a session. */
export interface CorrectionOutcome {
  /** The changes that differ from what is stored, in the order they were sent. */
  changes: MarkChange[];
  /** The marks after, without Present (an unmarked student was Present). */
  marks: { attendanceStatus: number }[];
}

/**
 * Applies a correction to the stored marks (DDD 13.1). A student not stored was Present; a change to the status a
 * student already has is no change. The counts of the session follow from the marks that remain.
 */
export function applyCorrection(
  stored: ReadonlyMap<string, number>,
  changes: readonly { studentEnrolmentId: string; attendanceStatus: number }[],
): CorrectionOutcome {
  const marks = new Map(stored);
  const effective: MarkChange[] = [];
  for (const change of changes) {
    const before = marks.get(change.studentEnrolmentId) ?? AttendanceStatus.Present;
    if (before === change.attendanceStatus) continue;
    effective.push({
      studentEnrolmentId: change.studentEnrolmentId,
      before,
      after: change.attendanceStatus,
    });
    if (change.attendanceStatus === AttendanceStatus.Present)
      marks.delete(change.studentEnrolmentId);
    else marks.set(change.studentEnrolmentId, change.attendanceStatus);
  }
  return {
    changes: effective,
    marks: [...marks.values()].map((attendanceStatus) => ({ attendanceStatus })),
  };
}
