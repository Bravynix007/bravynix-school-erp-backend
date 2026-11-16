/** How long a worker holds a job before another may take it over, and how often a handler renews it (seconds). */
export const LEASE_SECONDS = 60;

/** How many times a job is claimed before it is given up on. */
export const MAX_ATTEMPTS = 5;

/** The pause before a job that stopped on a passing fault runs again: longer for each attempt (seconds). */
export function retryDelaySeconds(attempts: number): number {
  return 30 * attempts;
}

/** How long an idle worker waits before it looks for a job again (milliseconds). */
export const POLL_MS = 2_000;

/** What the job record keeps of a failure: the code or the error's name, never its text, which may hold personal data. */
export function failureOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name.slice(0, 80);
  }
  return 'UNEXPECTED_ERROR';
}
