import { addDays, daysBetween, eachDay, isSunday, monthSpan } from './calendar-days.js';

describe('calendar days', () => {
  it('moves a date by days across months and years', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('counts whole days, across a month end and a leap day, backwards too', () => {
    expect(daysBetween('2026-12-22', '2026-12-22')).toBe(0);
    expect(daysBetween('2026-12-22', '2027-01-02')).toBe(11);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-11-18', '2026-11-17')).toBe(-1);
  });

  it('lists the days from one to another, both included, and none backwards', () => {
    expect(eachDay('2026-11-29', '2026-12-02')).toEqual([
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
    ]);
    expect(eachDay('2026-11-17', '2026-11-17')).toEqual(['2026-11-17']);
    expect(eachDay('2026-11-18', '2026-11-17')).toEqual([]);
  });

  it('knows a Sunday', () => {
    expect(isSunday('2026-11-22')).toBe(true);
    expect(isSunday('2026-11-23')).toBe(false);
  });

  it('gives the first and last day of a month, a leap February and December included', () => {
    expect(monthSpan('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthSpan('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthSpan('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});
