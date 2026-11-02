import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { ClassView } from './class.repository.js';

/** A named master entry as a class shows it. */
export interface NamedRef {
  id: string;
  code: string;
  name: string;
}

/** One class as the API shows it (API design 10.4j). */
export interface ClassResource extends AuthorStamps {
  id: string;
  institutionId: string;
  predefinedClass: NamedRef;
  category: NamedRef;
  streamName: string | null;
  displayName: string;
  code: string | null;
  sectionCount: number;
  status: number;
  version: number;
}

export function classResource(
  row: ClassView,
  people: ReadonlyMap<string, AuthorRef>,
): ClassResource {
  return {
    id: row.id,
    institutionId: row.institution_id,
    predefinedClass: {
      id: row.predefined_class_id,
      code: row.predefined_code,
      name: row.predefined_name,
    },
    category: { id: row.class_category_id, code: row.category_code, name: row.category_name },
    streamName: row.stream_name,
    displayName: row.display_name,
    code: row.code,
    sectionCount: row.section_count,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}

/** Everyone the rows name (classes or sections), for one lookup. */
export function peopleOf(
  rows: readonly { created_by: string | null; updated_by: string | null }[],
): string[] {
  return [
    ...new Set(
      rows
        .flatMap((row) => [row.created_by, row.updated_by])
        .filter((id): id is string => id !== null),
    ),
  ];
}
