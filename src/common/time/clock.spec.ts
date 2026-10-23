import { FixedClock, nextIstMidnight, toIstDate } from './clock.js';

describe('toIstDate', () => {
  it('uses the IST calendar day, not the UTC one', () => {
    // 20:00 UTC on 22 Oct is 01:30 IST on 23 Oct.
    expect(toIstDate(new Date('2026-10-22T20:00:00.000Z'))).toBe('2026-10-23');
    // 18:29 UTC is 23:59 IST, still the same day.
    expect(toIstDate(new Date('2026-10-22T18:29:59.999Z'))).toBe('2026-10-22');
    expect(toIstDate(new Date('2026-10-22T18:30:00.000Z'))).toBe('2026-10-23');
  });

  it('handles the year boundary', () => {
    expect(toIstDate(new Date('2026-12-31T18:30:00.000Z'))).toBe('2027-01-01');
  });
});

describe('nextIstMidnight', () => {
  it('returns the next 00:00 IST as a UTC instant', () => {
    expect(nextIstMidnight(new Date('2026-10-23T04:00:00.000Z')).toISOString()).toBe(
      '2026-10-23T18:30:00.000Z',
    );
  });

  it('moves to the following day when called exactly at midnight IST', () => {
    expect(nextIstMidnight(new Date('2026-10-23T18:30:00.000Z')).toISOString()).toBe(
      '2026-10-24T18:30:00.000Z',
    );
  });
});

describe('FixedClock', () => {
  it('stays put until moved', () => {
    const clock = new FixedClock('2026-10-23T04:30:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-10-23T04:30:00.000Z');
    clock.advanceMinutes(10);
    expect(clock.now().toISOString()).toBe('2026-10-23T04:40:00.000Z');
    clock.set('2026-10-23T18:30:00.000Z');
    expect(clock.todayIst()).toBe('2026-10-24');
  });

  it('hands out copies, so callers cannot move time by mutating a Date', () => {
    const clock = new FixedClock('2026-10-23T04:30:00.000Z');
    clock.now().setFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
