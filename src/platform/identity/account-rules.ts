import { AppException } from '../../common/http/app-exception.js';
import { isDuplicateOn } from '../database/index.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { AccountStatus, AuthCode } from './auth-codes.js';
import type { AccountRow } from './account.repository.js';

/** At most three seats of a kind: Super Admins on the platform, Owners in a Society (PRD decision 19). */
export const SEATS = [1, 2, 3] as const;

/** The lowest free seat, or the refusal when all are taken. */
export function nextSeat(taken: readonly number[]): number {
  const free = SEATS.find((seat) => !taken.includes(seat));
  if (free === undefined) throw AppException.conflict(ErrorCode.SEAT_LIMIT_REACHED);
  return free;
}

/** A blocked or inactive person cannot be given a role; a Pending or Active one can. */
export function requireCanHoldRole(person: AccountRow): void {
  if (person.account_status === AccountStatus.Blocked) {
    throw AppException.conflict(AuthCode.ACCOUNT_BLOCKED);
  }
  if (person.account_status === AccountStatus.Inactive) {
    throw AppException.conflict(ErrorCode.INVALID_STATE);
  }
}

/** An administrator may not block, remove or reset themselves: that is how a platform locks itself out. */
export function requireNotSelf(actorId: string, targetId: string): void {
  if (actorId === targetId) throw AppException.conflict(ErrorCode.CANNOT_ACT_ON_SELF);
}

/** An address as the audit log keeps it: enough to tell which, not enough to use (`a***@example.org`). */
export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 1)}***@${domain}`;
}

/** Two requests that both made a person of one new email: the loser is told the email is taken. */
export function emailInUse(error: unknown): unknown {
  return isDuplicateOn(error, 'uq_users_email')
    ? AppException.conflict(ErrorCode.EMAIL_IN_USE)
    : error;
}
