/** A calendar month as dates: `from` is its first day, `before` the first day of the next month (`YYYY-MM-DD`). */
export interface MonthRange {
  from: string;
  before: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const firstOf = (year: number, month: number) => `${String(year)}-${pad(month)}-01`;

/**
 * The month `today` falls in and the one before it, for "collected this month"
 * and the change since last month (PRD 9.6). `today` is a calendar date, already
 * in India (`Clock.todayIst`).
 */
export function monthsAround(today: string): { thisMonth: MonthRange; lastMonth: MonthRange } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    thisMonth: { from: firstOf(year, month), before: firstOf(nextYear, nextMonth) },
    lastMonth: { from: firstOf(previousYear, previousMonth), before: firstOf(year, month) },
  };
}
