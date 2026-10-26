import type { Db } from '../database/index.js';
import { AccountStatus, SessionEndReason } from './auth-codes.js';
import type { SessionRepository, SessionRow } from './session.repository.js';

const DAY_MS = 24 * 3600 * 1000;

/** Mobile sessions last 30 days from last use (SDD NFR-14). */
export const MOBILE_SESSION_MS = 30 * DAY_MS;

/** A console session lasts 12 hours from sign-in and is never extended (API design 6.1). */
export const CONSOLE_SESSION_MS = 12 * 3600 * 1000;

/**
 * A request moves the idle deadline only when the last move is older than
 * this, so a busy session does not write to the database on every call.
 */
export const TOUCH_AFTER_MS = 5 * 60 * 1000;

/** Roles 1 to 3 exist only by a grant row; 4 and 5 come from staff and guardian records (slice B5). */
function roleNeedsGrant(roleCode: number): boolean {
  return roleCode >= 1 && roleCode <= 3;
}

/**
 * The person was blocked, or lost the grant the session acts with: the session
 * ends now, not when the access token runs out (API design 6.5). A blocked
 * person loses every session, a lost grant ends only this one. Returns why the
 * session ended, or null when it may go on. The per-request check and refresh
 * both ask this, so the two cannot drift apart.
 */
export async function endIfNoLongerAllowed(
  sessions: SessionRepository,
  db: Db,
  session: SessionRow,
  now: Date,
): Promise<SessionEndReason | null> {
  if (
    session.accountStatus === AccountStatus.Blocked ||
    session.accountStatus === AccountStatus.Inactive
  ) {
    await sessions.endUserSessions(db, session.userId, SessionEndReason.AccountBlocked, now);
    return SessionEndReason.AccountBlocked;
  }
  if (
    session.activeRoleCode !== null &&
    roleNeedsGrant(session.activeRoleCode) &&
    !(await sessions.hasGrant(db, session.userId, session.activeRoleCode, session.activeSocietyId))
  ) {
    await sessions.endSession(db, session.id, SessionEndReason.AccessRevoked, now);
    return SessionEndReason.AccessRevoked;
  }
  return null;
}
