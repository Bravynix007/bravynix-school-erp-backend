import { ErrorCode } from '../../common/http/error-codes.js';
import { AppException } from '../../common/http/app-exception.js';

/** What a Society or an Institution row shares: version and soft-delete status. */
export interface TenantRootRow {
  version: number;
  status: number;
}

/** A deactivated record keeps its data but takes no more changes. */
export function requireActive(row: TenantRootRow): void {
  if (row.status !== 1) throw AppException.conflict(ErrorCode.INVALID_STATE);
}
