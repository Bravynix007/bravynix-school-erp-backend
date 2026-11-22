import type { PersonRef } from '../../platform/identity/index.js';
import { tally, type DayView } from './attendance-calendar.rules.js';
import { calendarDay, calendarResource, dayResource } from './student-calendar.resource.js';

const span = {
  studentEnrolmentId: 'enrolment-1',
  sectionId: 'section-1',
  classId: 'class-1',
  startDate: '2026-11-02',
  endDate: null,
  placedAt: new Date('2026-11-02T04:00:00.000Z'),
};
const marked: DayView = {
  date: '2026-11-03',
  dayStatus: 'absent',
  isWeekend: false,
  holidayTitle: null,
  span,
  session: {
    id: 'session-1',
    submittedAt: new Date('2026-11-03T04:30:00.000Z'),
    submittedBy: 'person-1',
    lastCorrectedAt: new Date('2026-11-03T06:00:00.000Z'),
  },
};
const unmarked: DayView = {
  date: '2026-11-01',
  dayStatus: 'not_enrolled',
  isWeekend: true,
  holidayTitle: null,
  span: undefined,
  session: undefined,
};
const people = new Map([['person-1', { displayName: 'Anna Rao' } as PersonRef]]);

describe('calendarDay', () => {
  it('keeps what the calendar draws and leaves out what the day was told from', () => {
    expect(calendarDay(marked)).toEqual({
      date: '2026-11-03',
      dayStatus: 'absent',
      isWeekend: false,
      holidayTitle: null,
    });
  });
});

describe('calendarResource', () => {
  it('puts the month, the counts, the year to date and the days together', () => {
    const resource = calendarResource(
      '2026-11',
      [unmarked, marked],
      tally([marked], '2026-11-17'),
      87.5,
    );
    expect(resource.month).toBe('2026-11');
    expect(resource.summary).toMatchObject({ absentDays: 1, attendancePercentage: 0 });
    expect(resource.yearToDate).toEqual({ attendancePercentage: 87.5 });
    expect(resource.days.map((day) => day.date)).toEqual(['2026-11-01', '2026-11-03']);
  });
});

describe('dayResource', () => {
  it('names the section and who marked the day, and when', () => {
    expect(dayResource(marked, { displayName: 'A', className: '10th' }, people)).toEqual({
      date: '2026-11-03',
      dayStatus: 'absent',
      isWeekend: false,
      holidayTitle: null,
      section: { id: 'section-1', name: 'A', className: '10th' },
      markedBy: { id: 'person-1', displayName: 'Anna Rao' },
      markedAt: '2026-11-03T04:30:00.000Z',
      lastCorrectedAt: '2026-11-03T06:00:00.000Z',
    });
  });

  it('has no section for a day without a placement, and no marker for a day nobody marked', () => {
    expect(dayResource(unmarked, undefined, people)).toMatchObject({
      section: null,
      markedBy: null,
      markedAt: null,
      lastCorrectedAt: null,
    });
  });

  it('keeps the section id but no names when the reader may not see them, and shows a marker who has gone as Unknown', () => {
    expect(
      dayResource(
        { ...marked, session: { ...marked.session!, lastCorrectedAt: null } },
        undefined,
        new Map(),
      ),
    ).toMatchObject({
      section: { id: 'section-1', name: null, className: null },
      markedBy: { id: 'person-1', displayName: 'Unknown' },
      lastCorrectedAt: null,
    });
  });
});
