import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { SubjectRow } from './subject.repository.js';

/** One subject as the API shows it (API design 10.4i). */
export interface SubjectResource extends AuthorStamps {
  id: string;
  name: string;
  code: string | null;
  status: number;
  version: number;
}

export function subjectResource(
  row: SubjectRow,
  people: ReadonlyMap<string, AuthorRef>,
): SubjectResource {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}

/** Everyone the subjects name, for one lookup. */
export function peopleOfSubjects(rows: readonly SubjectRow[]): string[] {
  return [
    ...new Set(
      rows
        .flatMap((row) => [row.created_by, row.updated_by])
        .filter((id): id is string => id !== null),
    ),
  ];
}
