const DAY_MS = 24 * 3600 * 1000;

/** Mobile sessions last 30 days from last use (SDD NFR-14); console sessions arrive with slice B8. */
export const MOBILE_SESSION_MS = 30 * DAY_MS;

/**
 * A request moves the idle deadline only when the last move is older than
 * this, so a busy session does not write to the database on every call.
 */
export const TOUCH_AFTER_MS = 5 * 60 * 1000;

/** Roles 1 to 3 exist only by a grant row; 4 and 5 come from staff and guardian records (slice B5). */
export function roleNeedsGrant(roleCode: number): boolean {
  return roleCode >= 1 && roleCode <= 3;
}
