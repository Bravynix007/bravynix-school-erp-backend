import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { DiaryEntryRow } from './diary.repository.js';

/** One entry as the API shows it (API design 10.14a). */
export interface DiaryEntryResource extends AuthorStamps {
  id: string;
  institutionId: string;
  academicYearId: string;
  sectionId: string;
  /** The section and its class, as a teacher's list names them; empty where the reader has no such names (a parent). */
  sectionName: string | null;
  className: string | null;
  subject: { id: string; name: string };
  diaryDate: string;
  description: string;
  /** "By: <teacher>"; `null` for an entry written by an admin with no staff record. */
  teacher: { id: string; displayName: string } | null;
  status: number;
  version: number;
}

/** The names an entry is shown with. */
export interface DiaryNames {
  subjects: ReadonlyMap<string, string>;
  teachers: ReadonlyMap<string, string>;
  sections: ReadonlyMap<string, { displayName: string; className: string }>;
}

export function diaryEntryResource(
  row: DiaryEntryRow,
  names: DiaryNames,
  people: ReadonlyMap<string, AuthorRef>,
): DiaryEntryResource {
  const section = names.sections.get(row.section_id);
  return {
    id: row.id,
    institutionId: row.institution_id,
    academicYearId: row.academic_year_id,
    sectionId: row.section_id,
    sectionName: section?.displayName ?? null,
    className: section?.className ?? null,
    subject: { id: row.subject_id, name: names.subjects.get(row.subject_id) ?? '' },
    diaryDate: row.diary_date,
    description: row.description,
    teacher:
      row.staff_member_id === null
        ? null
        : { id: row.staff_member_id, displayName: names.teachers.get(row.staff_member_id) ?? '' },
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
