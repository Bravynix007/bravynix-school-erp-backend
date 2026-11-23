import {
  attendancePercentage,
  dayOf,
  daysOf,
  markKey,
  sessionKey,
  tally,
  type CalendarInputs,
  type SessionFact,
} from './attendance-calendar.rules.js';
import type { PlacementSpan } from './student-attendance-access.js';

const span = (overrides: Partial<PlacementSpan> = {}): PlacementSpan => ({
  studentEnrolmentId: 'enrolment-1',
  sectionId: 'section-1',
  classId: 'class-1',
  startDate: '2026-06-01',
  endDate: null,
  placedAt: new Date('2026-06-01T04:00:00.000Z'),
  ...overrides,
});
const session = (overrides: Partial<SessionFact> = {}): SessionFact => ({
  id: 'session-1',
  submittedAt: new Date('2026-11-17T04:00:00.000Z'),
  submittedBy: 'person-1',
  lastCorrectedAt: null,
  ...overrides,
});
const inputs = (overrides: Partial<CalendarInputs> = {}): CalendarInputs => ({
  year: { startDate: '2026-06-01', endDate: '2027-03-31' },
  spans: [span()],
  sessions: new Map(),
  marks: new Map(),
  holidays: new Map(),
  ...overrides,
});
const marked = (date: string, ...more: SessionFact[]) =>
  new Map([[sessionKey('section-1', date), more[0] ?? session()]]);

describe('dayOf', () => {
  it('is Present on a day its section was marked and the student has no exception', () => {
    expect(dayOf('2026-11-17', inputs({ sessions: marked('2026-11-17') }))).toMatchObject({
      dayStatus: 'present',
      isWeekend: false,
      holidayTitle: null,
      session: { id: 'session-1' },
    });
  });

  it('tells each exception from the others', () => {
    const statuses = [
      [2, 'absent'],
      [3, 'late'],
      [4, 'half_day'],
      [5, 'leave'],
    ] as const;
    for (const [code, name] of statuses) {
      const day = dayOf(
        '2026-11-17',
        inputs({
          sessions: marked('2026-11-17'),
          marks: new Map([[markKey('enrolment-1', '2026-11-17'), code]]),
        }),
      );
      expect(day.dayStatus).toBe(name);
    }
  });

  it('is not marked on a day its section was not, and a Sunday says it is the weekly off', () => {
    expect(dayOf('2026-11-17', inputs())).toMatchObject({
      dayStatus: 'not_marked',
      isWeekend: false,
    });
    expect(dayOf('2026-11-22', inputs())).toMatchObject({
      dayStatus: 'not_marked',
      isWeekend: true,
    });
  });

  it('is a holiday of the student’s class, and the mark wins over a holiday added since', () => {
    const holidays = new Map([['class-1', new Map([['2026-11-17', 'Founders Day']])]]);
    expect(dayOf('2026-11-17', inputs({ holidays }))).toMatchObject({
      dayStatus: 'holiday',
      holidayTitle: 'Founders Day',
    });
    expect(dayOf('2026-11-17', inputs({ holidays, sessions: marked('2026-11-17') }))).toMatchObject(
      { dayStatus: 'present', holidayTitle: 'Founders Day' },
    );
    const other = new Map([['class-2', new Map([['2026-11-17', 'Not mine']])]]);
    expect(dayOf('2026-11-17', inputs({ holidays: other })).dayStatus).toBe('not_marked');
  });

  it('is not enrolled outside the year and outside any placement', () => {
    expect(dayOf('2026-05-31', inputs()).dayStatus).toBe('not_enrolled');
    expect(dayOf('2027-04-01', inputs()).dayStatus).toBe('not_enrolled');
    const placed = inputs({ spans: [span({ startDate: '2026-11-10', endDate: '2026-11-20' })] });
    expect(dayOf('2026-11-09', placed).dayStatus).toBe('not_enrolled');
    expect(dayOf('2026-11-20', placed).dayStatus).toBe('not_marked');
    expect(dayOf('2026-11-21', placed).dayStatus).toBe('not_enrolled');
  });

  it('does not count a session submitted before the student was placed', () => {
    const late = inputs({
      spans: [span({ placedAt: new Date('2026-11-17T09:00:00.000Z') })],
      sessions: marked('2026-11-17'),
    });
    expect(dayOf('2026-11-17', late)).toMatchObject({
      dayStatus: 'not_marked',
      session: undefined,
    });
  });

  it('follows the student from one section to the next', () => {
    const moved = inputs({
      spans: [
        span({ sectionId: 'section-1', endDate: '2026-11-16' }),
        span({ sectionId: 'section-2', startDate: '2026-11-17' }),
      ],
      sessions: new Map([[sessionKey('section-2', '2026-11-17'), session({ id: 'session-2' })]]),
    });
    expect(dayOf('2026-11-17', moved).session?.id).toBe('session-2');
    expect(dayOf('2026-11-16', moved).dayStatus).toBe('not_marked');
  });
});

/** A week of Monday to Sunday: four sessions with three marks, and a holiday on the Friday. */
const week = () =>
  daysOf(
    '2026-11-16',
    '2026-11-22',
    inputs({
      sessions: new Map(
        ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'].map((date) => [
          sessionKey('section-1', date),
          session(),
        ]),
      ),
      marks: new Map([
        [markKey('enrolment-1', '2026-11-17'), 2],
        [markKey('enrolment-1', '2026-11-18'), 4],
        [markKey('enrolment-1', '2026-11-19'), 3],
      ]),
      holidays: new Map([['class-1', new Map([['2026-11-20', 'Holiday']])]]),
    }),
  );

describe('tally', () => {
  it('counts each kind of day, the holiday and the school days still unmarked', () => {
    expect(tally(week(), '2026-11-21')).toEqual({
      presentDays: 1,
      absentDays: 1,
      lateDays: 1,
      halfDays: 1,
      leaveDays: 0,
      holidays: 1,
      notMarkedDays: 1,
      attendancePercentage: 62.5,
    });
  });

  it('counts neither the Sunday nor the days to come as missing', () => {
    expect(tally(week(), '2026-11-20').notMarkedDays).toBe(0);
    expect(tally(week(), '2026-11-22').notMarkedDays).toBe(1);
  });
});

describe('attendancePercentage', () => {
  it('has Present and Late as attended, Half day as half, and Absent and Leave as not', () => {
    expect(
      attendancePercentage({
        presentDays: 2,
        absentDays: 0,
        lateDays: 1,
        halfDays: 0,
        leaveDays: 0,
      }),
    ).toBe(100);
    expect(
      attendancePercentage({
        presentDays: 1,
        absentDays: 1,
        lateDays: 0,
        halfDays: 0,
        leaveDays: 1,
      }),
    ).toBe(33.33);
    expect(
      attendancePercentage({
        presentDays: 0,
        absentDays: 0,
        lateDays: 0,
        halfDays: 3,
        leaveDays: 0,
      }),
    ).toBe(50);
  });

  it('is none for a stretch with no day marked', () => {
    expect(
      attendancePercentage({
        presentDays: 0,
        absentDays: 0,
        lateDays: 0,
        halfDays: 0,
        leaveDays: 0,
      }),
    ).toBeNull();
  });
});
