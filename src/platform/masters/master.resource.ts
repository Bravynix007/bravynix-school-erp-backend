import { createHash } from 'node:crypto';
import type { MasterSpec } from './master.catalog.js';

/** A row of any master, as the database returns it. */
export interface MasterRow {
  id: string;
  status: number;
  version: number;
  [column: string]: unknown;
}

/**
 * One entry of a master (API design 10.4g): `id`, `status` (1 shown, 0 hidden), `version`, and the
 * fields of its master. Masters are public reference data, so an entry carries no author stamps:
 * they would name Super Admins to every signed-in person. The audit log keeps who changed what.
 */
export type MasterEntry = { id: string; status: number; version: number } & Record<string, unknown>;

export function masterEntry(spec: MasterSpec, row: MasterRow): MasterEntry {
  const entry: MasterEntry = { id: row.id, status: row.status, version: row.version };
  for (const { api, column } of spec.fields) entry[api] = row[column];
  return entry;
}

/** A weak validator of what the list says: the same entries answer the same tag, whoever asks. */
export function listEtag(entries: readonly MasterEntry[]): string {
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('base64url');
  return `W/"${digest.slice(0, 22)}"`;
}

const bare = (tag: string): string => tag.trim().replace(/^W\//, '');

/** Whether an `If-None-Match` header names this tag (weak comparison, RFC 9110 13.1.2); `*` names any. */
export function isNotModified(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || bare(tag) === bare(etag));
}
