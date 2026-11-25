import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import { clockOf } from '../../common/validation/clock-time.js';
import type { ExamPaperRow } from './exam-paper.repository.js';

/** One paper of a datesheet as the API shows it (API design 9.8, EXM-05 to EXM-08). */
export interface ExamPaperResource extends AuthorStamps {
  id: string;
  examId: string;
  institutionId: string;
  sectionId: string;
  /** The section and its class, as a teacher or an admin reads them; empty where the reader has no such names (a parent). */
  sectionName: string | null;
  className: string | null;
  subject: { id: string; name: string };
  /** `YYYY-MM-DD`. */
  examDate: string;
  /** `HH:MM`, 24-hour. */
  startTime: string;
  endTime: string;
  roomName: string | null;
  maxMarks: number;
  passingMarks: number;
  /** Empty for a parent, who reads when and where, not who. */
  subjectTeacher: { id: string; displayName: string } | null;
  invigilator: { id: string; displayName: string } | null;
  status: number;
  version: number;
}

/** The names a paper is shown with; a parent's have no sections and no staff. */
export interface PaperNames {
  subjects: ReadonlyMap<string, string>;
  staff: ReadonlyMap<string, string>;
  sections: ReadonlyMap<string, { displayName: string; className: string }>;
}

export function examPaperResource(
  row: ExamPaperRow,
  names: PaperNames,
  people: ReadonlyMap<string, AuthorRef>,
  forParent = false,
): ExamPaperResource {
  const section = names.sections.get(row.section_id);
  const staff = (id: string | null) =>
    id === null || forParent ? null : { id, displayName: names.staff.get(id) ?? '' };
  return {
    id: row.id,
    examId: row.exam_id,
    institutionId: row.institution_id,
    sectionId: row.section_id,
    sectionName: section?.displayName ?? null,
    className: section?.className ?? null,
    subject: { id: row.subject_id, name: names.subjects.get(row.subject_id) ?? '' },
    examDate: row.exam_date,
    startTime: clockOf(row.start_time),
    endTime: clockOf(row.end_time),
    roomName: row.room_name,
    maxMarks: row.max_marks,
    passingMarks: row.passing_marks,
    subjectTeacher: staff(row.subject_teacher_staff_member_id),
    invigilator: staff(row.invigilator_staff_member_id),
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
