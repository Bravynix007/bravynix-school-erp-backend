/**
 * The only source of "now" in the codebase. Never call `new Date()` or
 * `Date.now()` in business code: inject `Clock` so tests can move time for
 * OTP expiry, lockouts, due dates, the midnight IST AI purge and 60-minute
 * support sessions.
 */
export abstract class Clock {
  abstract now(): Date;

  /** Today's school day in India Standard Time, as YYYY-MM-DD (DDD principle 10). */
  todayIst(): string {
    return toIstDate(this.now());
  }
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock that only moves when told to. Use it in tests. */
export class FixedClock extends Clock {
  private current: Date;

  constructor(start: Date | string = '2026-06-01T04:30:00.000Z') {
    super();
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(instant: Date | string): void {
    this.current = new Date(instant);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }
}

const IST_OFFSET_MS = 330 * 60_000;

export function toIstDate(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant of the next midnight IST after `instant`. */
export function nextIstMidnight(instant: Date): Date {
  const istDay = toIstDate(instant);
  const midnightIst = Date.parse(`${istDay}T00:00:00.000Z`) - IST_OFFSET_MS;
  return new Date(midnightIst + 24 * 60 * 60_000);
}
