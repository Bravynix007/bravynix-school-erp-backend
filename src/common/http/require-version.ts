import { AppException } from './app-exception.js';

/** A stale screen is told to reload before anything else (API design 14.3). */
export function requireVersion(row: { version: number }, version: number): void {
  if (row.version !== version) throw AppException.versionConflict(row.version);
}
