import { clockOf } from '../../common/validation/clock-time.js';
import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { TimetableEntryWithSlot } from './timetable-entry.repository.js';

/** One entry of a week as the API shows it (API design 9.7). */
export interface TimetableEntryResource extends AuthorStamps {
  id: string;
  institutionId: string;
  academicYearId: string;
  sectionId: string;
  /** The section and its class, as a teacher's week names them; empty where the reader has no such names (a parent). */
  sectionName: string | null;
  className: string | null;
  /** 1 Monday to 6 Saturday. */
  dayOfWeek: number;
  timeSlot: {
    id: string;
    periodNo: number;
    label: string | null;
    /** `HH:MM`, 24-hour. */
    startTime: string;
    endTime: string;
  };
  isBreak: boolean;
  subject: { id: string; name: string } | null;
  teacher: { id: string; displayName: string } | null;
  status: number;
  version: number;
}

/** The names an entry is shown with. */
export interface EntryNames {
  subjects: ReadonlyMap<string, string>;
  teachers: ReadonlyMap<string, string>;
  sections: ReadonlyMap<string, { displayName: string; className: string }>;
}

export function timetableEntryResource(
  row: TimetableEntryWithSlot,
  names: EntryNames,
  people: ReadonlyMap<string, AuthorRef>,
): TimetableEntryResource {
  const section = names.sections.get(row.section_id);
  return {
    id: row.id,
    institutionId: row.institution_id,
    academicYearId: row.academic_year_id,
    sectionId: row.section_id,
    sectionName: section?.displayName ?? null,
    className: section?.className ?? null,
    dayOfWeek: row.day_of_week,
    timeSlot: {
      id: row.time_slot_id,
      periodNo: row.period_no,
      label: row.label,
      startTime: clockOf(row.start_time),
      endTime: clockOf(row.end_time),
    },
    isBreak: row.is_break,
    subject:
      row.subject_id === null
        ? null
        : { id: row.subject_id, name: names.subjects.get(row.subject_id) ?? '' },
    teacher:
      row.staff_member_id === null
        ? null
        : { id: row.staff_member_id, displayName: names.teachers.get(row.staff_member_id) ?? '' },
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
