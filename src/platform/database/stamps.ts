import { RequestContext } from '../../common/request-context/request-context.js';

/**
 * "Added by" and "Updated by" (PRD decision 34, DDD 5.2). `created_at` and
 * `updated_at` come from the database; these give the two `*_by` columns.
 *
 * The author is the caller of the request. A background job has none, so both
 * columns stay empty and the app shows "System". Pass an author explicitly
 * where the request has no caller yet (a login), or `null` to force "System".
 */
function author(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit;
  return RequestContext.current()?.personId ?? null;
}

/** Columns to add to an insert. */
export function insertStamp(by?: string | null): {
  created_by: string | null;
  updated_by: string | null;
} {
  const who = author(by);
  return { created_by: who, updated_by: who };
}

/** Columns to add to an update; `updated_at` and `version` are moved by triggers. */
export function updateStamp(by?: string | null): { updated_by: string | null } {
  return { updated_by: author(by) };
}
