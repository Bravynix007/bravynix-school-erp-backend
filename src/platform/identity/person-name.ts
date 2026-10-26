/** First and last name joined, or `null` when the person has neither. */
export function personName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  return [firstName, lastName].filter(Boolean).join(' ') || null;
}
