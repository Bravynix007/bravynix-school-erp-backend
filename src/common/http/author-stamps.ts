/** A person in an author stamp (API design 7.6). */
export interface AuthorRef {
  id: string | null;
  displayName: string;
  roleName: string | null;
}

/** A row made by a background job, or with no author on record. */
export const SYSTEM_AUTHOR: AuthorRef = { id: null, displayName: 'System', roleName: null };

export interface AuthorStampColumns {
  created_by: string | null;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date;
}

export interface AuthorStamps {
  createdBy: AuthorRef;
  createdAt: string;
  updatedBy: AuthorRef;
  updatedAt: string;
}

/** The person for an ID, `System` for none; an ID nobody knows keeps its ID and shows "Unknown". */
export function authorOf(id: string | null, people: ReadonlyMap<string, AuthorRef>): AuthorRef {
  if (id === null) return SYSTEM_AUTHOR;
  return people.get(id) ?? { id, displayName: 'Unknown', roleName: null };
}

/** `createdBy`, `createdAt`, `updatedBy` and `updatedAt` of a row, on every resource (API design 7.6). */
export function authorStamps(
  row: AuthorStampColumns,
  people: ReadonlyMap<string, AuthorRef>,
): AuthorStamps {
  return {
    createdBy: authorOf(row.created_by, people),
    createdAt: row.created_at.toISOString(),
    updatedBy: authorOf(row.updated_by, people),
    updatedAt: row.updated_at.toISOString(),
  };
}
