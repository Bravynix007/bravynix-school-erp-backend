import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { FileBrief } from '../../platform/files/index.js';
import type { DocumentRow } from './document.repository.js';

/** One document on a staff member's Documents tab (STF-14, STF-15). A link to the file comes from FIL-03. */
export interface DocumentResource extends AuthorStamps {
  id: string;
  ownerType: 'staff';
  staffMemberId: string;
  title: string;
  file: FileBrief;
}

export function documentResource(
  row: DocumentRow,
  file: FileBrief,
  people: ReadonlyMap<string, AuthorRef>,
): DocumentResource {
  // The table's check (`ck_documents_owner`) gives every document of this build a staff owner.
  if (row.staff_member_id === null) throw new Error(`Document ${row.id} has no staff owner`);
  return {
    id: row.id,
    ownerType: 'staff',
    staffMemberId: row.staff_member_id,
    title: row.title,
    file,
    ...authorStamps(row, people),
  };
}
