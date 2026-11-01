/** A rate and the first day it applies, as stored. */
export interface DatedRate {
  id: string;
  effective_from_date: string;
}

/**
 * The rate in force on a day: the latest one that took effect on or before it
 * (PRD 9.2). `YYYY-MM-DD` dates order correctly as plain strings. `undefined`
 * when the first rate starts later.
 */
export function rateInForce<R extends DatedRate>(rates: readonly R[], day: string): R | undefined {
  let found: R | undefined;
  for (const rate of rates) {
    if (
      rate.effective_from_date <= day &&
      (!found || rate.effective_from_date > found.effective_from_date)
    ) {
      found = rate;
    }
  }
  return found;
}
