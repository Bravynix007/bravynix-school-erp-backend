/** The enrolment outcomes a promotion records (DDD 9.6): 1 Promoted, 2 Repeating, 4 Completed the final class. */
export const OUTCOME_PROMOTED = 1;
export const OUTCOME_REPEATING = 2;
export const OUTCOME_COMPLETED = 4;

/** Why a student who completed the final class is deactivated: `inactive_reason` 4, Completed (DDD 9.6). */
export const INACTIVE_COMPLETED = 4;

/** The most students one promotion takes (API design 10.7). */
export const MAX_PROMOTED_AT_ONCE = 500;

/**
 * What the old enrolment ends as: a student with no new class completed the final class, one who stays in the same
 * class repeats it, and any other is promoted.
 */
export function outcomeOf(fromClassId: string, toClassId: string | null): number {
  if (toClassId === null) return OUTCOME_COMPLETED;
  return toClassId === fromClassId ? OUTCOME_REPEATING : OUTCOME_PROMOTED;
}

/** The day the old placement ends: the old year's last day, but never before the placement began. */
export function oldPlacementEnd(placementStart: string, yearEnd: string): string {
  return placementStart > yearEnd ? placementStart : yearEnd;
}

const NUMBER = /^[0-9]+$/;

/** Roll numbers in the order of a class list: numbers in numeric order, then the rest in text order. */
export function compareRollNumbers(a: string, b: string): number {
  const aNumber = NUMBER.test(a);
  const bNumber = NUMBER.test(b);
  if (aNumber && bNumber) return Number(a) - Number(b) || a.localeCompare(b);
  if (aNumber) return -1;
  if (bNumber) return 1;
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

/**
 * New roll numbers for students who do not keep theirs: the old ones in the order of a class list, numbered one after
 * the highest number the target section holds already (from 1 when it holds none).
 */
export function renumber(oldRolls: readonly string[], taken: readonly string[]): string[] {
  const highest = Math.max(0, ...taken.filter((roll) => NUMBER.test(roll)).map(Number));
  const order = oldRolls
    .map((roll, index) => ({ roll, index }))
    .toSorted((a, b) => compareRollNumbers(a.roll, b.roll) || a.index - b.index);
  const numbered = Array.from<string>({ length: oldRolls.length });
  for (const [position, { index }] of order.entries())
    numbered[index] = String(highest + position + 1);
  return numbered;
}
