/** Whole seconds until `target`, at least 1, for a `Retry-After` header. */
export function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

/** The later of two optional times, or null when neither is set. */
export function latest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}
