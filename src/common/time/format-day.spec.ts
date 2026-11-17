import { formatDay } from './format-day.js';

describe('formatDay', () => {
  it('writes the day, the month in three letters and the year, with no leading zero', () => {
    expect(formatDay('2026-12-22')).toBe('22 Dec 2026');
    expect(formatDay('2027-01-05')).toBe('5 Jan 2027');
  });
});
