import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { NamedRef } from './class.resource.js';
import type { SectionView } from './section.repository.js';

/**
 * One section as the API shows it (API design 10.4j). The student count and the class teacher need the People
 * module (Phase 4): until then they are `null`, so the screens can already read the final shape.
 */
export interface SectionResource extends AuthorStamps {
  id: string;
  classId: string;
  institutionId: string;
  predefinedSection: NamedRef;
  displayName: string;
  capacity: number | null;
  currentStudentCount: null;
  classTeacher: null;
  status: number;
  version: number;
}

export function sectionResource(
  row: SectionView,
  people: ReadonlyMap<string, AuthorRef>,
): SectionResource {
  return {
    id: row.id,
    classId: row.class_id,
    institutionId: row.institution_id,
    predefinedSection: {
      id: row.predefined_section_id,
      code: row.predefined_code,
      name: row.predefined_name,
    },
    displayName: row.display_name,
    capacity: row.capacity,
    currentStudentCount: null,
    classTeacher: null,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
