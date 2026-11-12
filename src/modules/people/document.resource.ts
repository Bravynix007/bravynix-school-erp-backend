import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { FileBrief } from '../../platform/files/index.js';
import type { DocumentRow } from './document.repository.js';

interface DocumentBase extends AuthorStamps {
  id: string;
  title: string;
  file: FileBrief;
}

/** One document on a staff member's Documents tab (STF-14, STF-15). A link to the file comes from FIL-03. */
export interface StaffDocumentResource extends DocumentBase {
  ownerType: 'staff';
  staffMemberId: string;
}

/** One document on a student's Documents tab (DOC-01, DOC-02). A link to the file comes from FIL-03. */
export interface StudentDocumentResource extends DocumentBase {
  ownerType: 'student';
  studentId: string;
}

export type DocumentResource = StaffDocumentResource | StudentDocumentResource;

export function documentResource(
  row: DocumentRow,
  file: FileBrief,
  people: ReadonlyMap<string, AuthorRef>,
): DocumentResource {
  const base = { id: row.id, title: row.title, file, ...authorStamps(row, people) };
  // The table's check (`ck_documents_owner`) gives every document exactly the owner its type names.
  if (row.owner_type === 1 && row.student_id !== null) {
    return { ...base, ownerType: 'student', studentId: row.student_id };
  }
  if (row.owner_type === 2 && row.staff_member_id !== null) {
    return { ...base, ownerType: 'staff', staffMemberId: row.staff_member_id };
  }
  throw new Error(`Document ${row.id} has no owner`);
}
