import {
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { RoleCode } from '../../common/auth/roles.js';
import { mayEdit } from './event.rules.js';
import type { EventRow } from './event.repository.js';

/** One event as the API shows it (API design 10.26). */
export interface EventResource extends AuthorStamps {
  id: string;
  title: string;
  description: string | null;
  venue: string | null;
  startDate: string;
  endDate: string;
  durationLabel: string;
  audience: number;
  scope: number;
  institutionId: string | null;
  presetImageCode: string | null;
  isHoliday: boolean;
  holidayType: number | null;
  holidayForStudents: boolean;
  holidayForStaff: boolean;
  /** The predefined classes a holiday is for; empty is every class. */
  holidayPredefinedClassIds: string[];
  /** Whether the caller sees Edit and Delete on it (PRD 7.12). */
  canEdit: boolean;
  status: number;
  version: number;
}

export function eventResource(
  row: EventRow,
  classIds: readonly string[],
  role: RoleCode | null,
  people: ReadonlyMap<string, AuthorRef>,
): EventResource {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    venue: row.venue,
    startDate: row.start_date,
    endDate: row.end_date,
    durationLabel: row.duration_label,
    audience: row.audience,
    scope: row.scope,
    institutionId: row.institution_id,
    presetImageCode: row.preset_image_code,
    isHoliday: row.is_holiday,
    holidayType: row.holiday_type,
    holidayForStudents: row.holiday_for_students,
    holidayForStaff: row.holiday_for_staff,
    holidayPredefinedClassIds: [...classIds],
    canEdit: mayEdit(role, row.scope),
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}
