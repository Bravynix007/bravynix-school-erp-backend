import { isCalendarDate } from './calendar-date.js';

describe('isCalendarDate', () => {
  it.each(['2026-11-21', '2028-02-29', '2026-12-31'])('takes %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-3-1',
    '21/11/2026',
    '2026-11-21T00:00',
    '',
  ])('refuses %j', (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });
});
