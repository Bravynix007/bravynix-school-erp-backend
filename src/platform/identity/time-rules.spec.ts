import { latest, secondsUntil } from './time-rules.js';

const at = (iso: string) => new Date(iso);

describe('secondsUntil', () => {
  const now = at('2026-10-26T10:00:00Z');

  it('rounds up to whole seconds', () => {
    expect(secondsUntil(at('2026-10-26T10:00:01.200Z'), now)).toBe(2);
  });

  it('is never less than 1, so a Retry-After header is never 0 or negative', () => {
    expect(secondsUntil(now, now)).toBe(1);
    expect(secondsUntil(at('2026-10-26T09:59:00Z'), now)).toBe(1);
  });
});

describe('latest', () => {
  const early = at('2026-10-26T10:00:00Z');
  const late = at('2026-10-26T11:00:00Z');

  it('picks the later of two times in either order', () => {
    expect(latest(early, late)).toBe(late);
    expect(latest(late, early)).toBe(late);
  });

  it('ignores a missing time and is null when both are missing', () => {
    expect(latest(early, null)).toBe(early);
    expect(latest(undefined, late)).toBe(late);
    expect(latest(null, undefined)).toBeNull();
  });
});
