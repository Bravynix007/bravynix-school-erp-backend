import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { ExamRow } from './exam.repository.js';

/** One exam as the API shows it (API design 9.8, EXM-01 to EXM-04). */
export interface ExamResource extends AuthorStamps {
  id: string;
  institutionId: string;
  academicYearId: string;
  name: string;
  /** 1 Unit test, 2 Mid term, 3 Final, 4 Quarterly, 5 Half yearly, 6 Annual. */
  examType: number;
  /** `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  /** When the datesheet was published to the sections, or `null` while it is not (EXM-09). */
  datesheetPublishedAt: string | null;
  status: number;
  version: number;
}

export function examResource(row: ExamRow, people: ReadonlyMap<string, AuthorRef>): ExamResource {
  return {
    id: row.id,
    institutionId: row.institution_id,
    academicYearId: row.academic_year_id,
    name: row.name,
    examType: row.exam_type,
    startDate: row.start_date,
    endDate: row.end_date,
    datesheetPublishedAt: row.datesheet_published_at?.toISOString() ?? null,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
