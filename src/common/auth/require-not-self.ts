import { AppException } from '../http/app-exception.js';
import { ErrorCode } from '../http/error-codes.js';

/** An administrator may not block, remove or reset themselves: that is how a platform locks itself out. */
export function requireNotSelf(actorId: string, targetId: string): void {
  if (actorId === targetId) throw AppException.conflict(ErrorCode.CANNOT_ACT_ON_SELF);
}
