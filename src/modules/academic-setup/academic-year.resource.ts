import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { AcademicYearRow } from './academic-year.repository.js';

/** One academic year as the API shows it (API design 10.4h). */
export interface AcademicYearResource extends AuthorStamps {
  id: string;
  institutionId: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  status: number;
  version: number;
}

export function academicYearResource(
  row: AcademicYearRow,
  people: ReadonlyMap<string, AuthorRef>,
): AcademicYearResource {
  return {
    id: row.id,
    institutionId: row.institution_id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    isCurrent: row.is_current,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}

/** Everyone the years name, for one lookup. */
export function peopleOfYears(rows: readonly AcademicYearRow[]): string[] {
  return [
    ...new Set(
      rows
        .flatMap((row) => [row.created_by, row.updated_by])
        .filter((id): id is string => id !== null),
    ),
  ];
}
