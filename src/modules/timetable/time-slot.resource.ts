import { clockOf } from '../../common/validation/clock-time.js';
import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { TimeSlotRow } from './time-slot.repository.js';

/** One period as the API shows it (API design 9.4). */
export interface TimeSlotResource extends AuthorStamps {
  id: string;
  institutionId: string;
  academicYearId: string;
  periodNo: number;
  label: string | null;
  /** `HH:MM`, 24-hour. */
  startTime: string;
  endTime: string;
  isBreak: boolean;
  status: number;
  version: number;
}

export function timeSlotResource(
  row: TimeSlotRow,
  people: ReadonlyMap<string, AuthorRef>,
): TimeSlotResource {
  return {
    id: row.id,
    institutionId: row.institution_id,
    academicYearId: row.academic_year_id,
    periodNo: row.period_no,
    label: row.label,
    startTime: clockOf(row.start_time),
    endTime: clockOf(row.end_time),
    isBreak: row.is_break,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
