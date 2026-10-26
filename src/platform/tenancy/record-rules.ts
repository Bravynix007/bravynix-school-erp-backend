import { ErrorCode } from '../../common/http/error-codes.js';
import { AppException } from '../../common/http/app-exception.js';

/** What a Society or an Institution row shares: version, soft-delete status and the access pause. */
export interface TenantRootRow {
  version: number;
  status: number;
  access_paused_at: Date | null;
}

/** A deactivated record keeps its data but takes no more changes. */
export function requireActive(row: TenantRootRow): void {
  if (row.status !== 1) throw AppException.conflict(ErrorCode.INVALID_STATE);
}

export function requirePausable(row: TenantRootRow): void {
  requireActive(row);
  if (row.access_paused_at !== null) throw AppException.conflict(ErrorCode.INVALID_STATE);
}

export function requireResumable(row: TenantRootRow): void {
  requireActive(row);
  if (row.access_paused_at === null) throw AppException.conflict(ErrorCode.INVALID_STATE);
}

/** The three pause columns are all set or all empty (PRD 9.4). */
export function pauseColumns(by: string, at: Date, reason: string) {
  return { access_paused_at: at, access_paused_by: by, access_pause_reason: reason };
}

export const RESUME_COLUMNS = {
  access_paused_at: null,
  access_paused_by: null,
  access_pause_reason: null,
};
