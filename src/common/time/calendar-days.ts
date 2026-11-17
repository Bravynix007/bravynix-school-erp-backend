const DAY_MS = 86_400_000;

function at(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The date `days` after `date` (before, for a negative number), as `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  return dayOf(at(date) + days * DAY_MS);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`: 0 for the same day, negative when `to` is first. */
export function daysBetween(from: string, to: string): number {
  return Math.round((at(to) - at(from)) / DAY_MS);
}

/** Every date from `from` to `to`, both included; none when `to` is before `from`. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Whether the date is a Sunday, the weekly off (decision 5). */
export function isSunday(date: string): boolean {
  return new Date(at(date)).getUTCDay() === 0;
}

/** The first and last day of a month written `YYYY-MM`. */
export function monthSpan(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const next = new Date(at(from));
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDays(dayOf(next.getTime()), -1) };
}
