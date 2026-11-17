import { AppException } from '../../common/http/app-exception.js';
import {
  AttendanceStatus,
  EXCEPTION_STATUSES,
  applyCorrection,
  countMarks,
  dateRefusal,
  requireEachStudentOnce,
  requireMarkableDate,
} from './attendance.rules.js';

/** What the call throws. */
function thrown(work: () => void): AppException {
  try {
    work();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Nothing was thrown');
}

const year = { startDate: '2026-06-01', endDate: '2027-03-31' };

describe('AttendanceStatus', () => {
  it('sends every status but Present', () => {
    expect(EXCEPTION_STATUSES).toEqual([
      AttendanceStatus.Absent,
      AttendanceStatus.Late,
      AttendanceStatus.HalfDay,
      AttendanceStatus.Leave,
    ]);
  });
});

describe('countMarks', () => {
  it('counts each status, and nothing for no marks', () => {
    expect(countMarks([])).toEqual({ absent: 0, late: 0, halfDay: 0, leave: 0 });
    expect(
      countMarks([2, 2, 3, 4, 5, 5, 5].map((attendanceStatus) => ({ attendanceStatus }))),
    ).toEqual({ absent: 2, late: 1, halfDay: 1, leave: 3 });
  });
});

describe('requireEachStudentOnce', () => {
  it('names the second mention of a student', () => {
    expect(() =>
      requireEachStudentOnce([
        { studentEnrolmentId: 'a' },
        { studentEnrolmentId: 'b' },
        { studentEnrolmentId: 'a' },
      ]),
    ).toThrow(AppException);
    const error = thrown(() => {
      requireEachStudentOnce([{ studentEnrolmentId: 'a' }, { studentEnrolmentId: 'a' }]);
    });
    expect(error.options.errors).toMatchObject([
      { field: 'exceptions[1].studentEnrolmentId', code: 'INVALID_VALUE' },
    ]);
  });

  it('takes distinct students, and none', () => {
    expect(() => {
      requireEachStudentOnce([{ studentEnrolmentId: 'a' }, { studentEnrolmentId: 'b' }]);
      requireEachStudentOnce([]);
    }).not.toThrow();
  });
});

describe('dateRefusal', () => {
  it('refuses a day that has not come first, then a day outside the year', () => {
    expect(dateRefusal('2026-11-18', '2026-11-17', year)).toBe('DATE_IN_FUTURE');
    expect(dateRefusal('2026-05-31', '2026-11-17', year)).toBe('DATE_OUTSIDE_CURRENT_YEAR');
    expect(dateRefusal('2027-04-01', '2027-04-05', year)).toBe('DATE_OUTSIDE_CURRENT_YEAR');
    expect(dateRefusal('2027-04-10', '2027-04-05', year)).toBe('DATE_IN_FUTURE');
  });

  it('takes today, and the first and the last day of the year', () => {
    expect(dateRefusal('2026-11-17', '2026-11-17', year)).toBeUndefined();
    expect(dateRefusal('2026-06-01', '2026-11-17', year)).toBeUndefined();
    expect(dateRefusal('2027-03-31', '2027-03-31', year)).toBeUndefined();
  });
});

describe('requireMarkableDate', () => {
  it('throws the refusal as a 422 and lets a good day through', () => {
    expect(() => {
      requireMarkableDate('2026-11-17', '2026-11-17', year);
    }).not.toThrow();
    const error = thrown(() => {
      requireMarkableDate('2026-12-01', '2026-11-17', year);
    });
    expect([error.status as number, error.code]).toEqual([422, 'DATE_IN_FUTURE']);
  });
});

describe('applyCorrection', () => {
  const stored = new Map([
    ['a', AttendanceStatus.Absent],
    ['b', AttendanceStatus.Late],
  ]);

  it('adds, changes and removes marks, and says what each was and became', () => {
    const outcome = applyCorrection(stored, [
      { studentEnrolmentId: 'a', attendanceStatus: AttendanceStatus.Present },
      { studentEnrolmentId: 'b', attendanceStatus: AttendanceStatus.Leave },
      { studentEnrolmentId: 'c', attendanceStatus: AttendanceStatus.HalfDay },
    ]);
    expect(outcome.changes).toEqual([
      { studentEnrolmentId: 'a', before: 1 + 1, after: 1 },
      { studentEnrolmentId: 'b', before: 3, after: 5 },
      { studentEnrolmentId: 'c', before: 1, after: 4 },
    ]);
    expect(countMarks(outcome.marks)).toEqual({ absent: 0, late: 0, halfDay: 1, leave: 1 });
  });

  it('leaves out a change to the status a student already has, Present included', () => {
    const outcome = applyCorrection(stored, [
      { studentEnrolmentId: 'a', attendanceStatus: AttendanceStatus.Absent },
      { studentEnrolmentId: 'z', attendanceStatus: AttendanceStatus.Present },
    ]);
    expect(outcome.changes).toEqual([]);
    expect(countMarks(outcome.marks)).toEqual({ absent: 1, late: 1, halfDay: 0, leave: 0 });
  });

  it('does not touch the marks it was given', () => {
    applyCorrection(stored, [{ studentEnrolmentId: 'a', attendanceStatus: 1 }]);
    expect([...stored.keys()]).toEqual(['a', 'b']);
  });
});
