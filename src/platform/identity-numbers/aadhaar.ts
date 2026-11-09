/**
 * The Aadhaar number as the rules want it (DDD 15.6, API design 12): twelve
 * digits once spaces and hyphens are removed, the first of them 2 to 9 (the
 * UIDAI never issues a number that starts with 0 or 1), with the Verhoeff
 * check digit.
 */

// Verhoeff's multiplication and permutation tables (the dihedral group D5).
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

/** True when the last digit of `digits` is the Verhoeff check digit of the rest. */
export function hasValidCheckDigit(digits: string): boolean {
  let c = 0;
  const reversed = [...digits].toReversed();
  for (const [i, char] of reversed.entries()) {
    c = D[c]![P[i % 8]![Number(char)]!]!;
  }
  return c === 0;
}

/**
 * The twelve digits of a number typed as "2345 6789 0124" or "2345-6789-0124",
 * or null when it is not an Aadhaar number (wrong length, other characters,
 * a first digit of 0 or 1, or a failed check digit).
 */
export function normaliseAadhaar(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  return /^[2-9]\d{11}$/.test(digits) && hasValidCheckDigit(digits) ? digits : null;
}

/** "XXXX XXXX 1234" for the last four digits kept in the clear. */
export function maskAadhaar(last4: string): string {
  return `XXXX XXXX ${last4}`;
}
