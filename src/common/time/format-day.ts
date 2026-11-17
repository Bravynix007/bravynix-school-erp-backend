const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date (`YYYY-MM-DD`) as a notice shows it: `22 Dec 2026`. */
export function formatDay(date: string): string {
  const [year, month, day] = date.split('-');
  return `${Number(day).toString()} ${MONTHS[Number(month) - 1]!} ${year!}`;
}
