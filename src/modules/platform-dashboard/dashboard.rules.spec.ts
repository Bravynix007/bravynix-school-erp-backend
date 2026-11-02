import { monthsAround } from './dashboard.rules.js';

describe('monthsAround', () => {
  it.each([
    ['2026-11-02', '2026-11-01', '2026-12-01', '2026-10-01', '2026-11-01'],
    ['2026-11-30', '2026-11-01', '2026-12-01', '2026-10-01', '2026-11-01'],
    ['2026-12-31', '2026-12-01', '2027-01-01', '2026-11-01', '2026-12-01'],
    ['2027-01-01', '2027-01-01', '2027-02-01', '2026-12-01', '2027-01-01'],
    ['2028-03-15', '2028-03-01', '2028-04-01', '2028-02-01', '2028-03-01'],
  ])('around %s', (today, from, before, lastFrom, lastBefore) => {
    expect(monthsAround(today)).toEqual({
      thisMonth: { from, before },
      lastMonth: { from: lastFrom, before: lastBefore },
    });
  });
});
