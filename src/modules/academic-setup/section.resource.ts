import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { NamedRef } from './class.resource.js';
import type { SectionView } from './section.repository.js';
import type { ClassTeacherRef } from './teaching-staff.js';

/**
 * One section as the API shows it (API design 10.4j). The class teacher is the one of the Institution's current
 * year, or `null`; the student count is how many students sit in the section now.
 */
export interface SectionResource extends AuthorStamps {
  id: string;
  classId: string;
  institutionId: string;
  predefinedSection: NamedRef;
  displayName: string;
  capacity: number | null;
  currentStudentCount: number;
  classTeacher: ClassTeacherRef | null;
  status: number;
  version: number;
}

export function sectionResource(
  row: SectionView,
  people: ReadonlyMap<string, AuthorRef>,
  classTeacher: ClassTeacherRef | null,
  currentStudentCount: number,
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
    currentStudentCount,
    classTeacher,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
