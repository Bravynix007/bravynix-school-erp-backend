import {
  authorOf,
  authorStamps,
  type AuthorRef,
  type AuthorStamps,
} from '../../common/http/author-stamps.js';
import type { Phone } from '../../common/validation/phone.dto.js';
import type { SocietyInstitution, SocietyRow } from './society.repository.js';

/** The Society as the API shows it (API design 10.4b). Every field is present; empty ones are `null`. */
export interface SocietyResource extends AuthorStamps {
  id: string;
  code: string;
  name: string;
  description: string | null;
  email: string | null;
  phone: Phone | null;
  website: string | null;
  foundedDate: string | null;
  address: { line1: string | null; line2: string | null; pincode: string | null };
  status: number;
  accessPause: { pausedAt: string; pausedBy: AuthorRef; reason: string } | null;
  institutionCount: number;
  version: number;
}

/** One row of the PLT-02 list. */
export interface SocietySummary extends AuthorStamps {
  id: string;
  code: string;
  name: string;
  status: number;
  paused: boolean;
  institutionCount: number;
}

export interface SocietyDetail extends SocietyResource {
  institutions: { id: string; code: string; name: string; status: number; paused: boolean }[];
  owners: { id: string; displayName: string; email: string; accountStatus: number }[];
}

export type People = ReadonlyMap<string, AuthorRef>;

/** Everyone a Society row names, for one lookup. */
export function peopleOf(rows: readonly SocietyRow[]): string[] {
  return rows
    .flatMap((row) => [row.created_by, row.updated_by, row.access_paused_by])
    .filter((id): id is string => id !== null);
}

export function societyResource(row: SocietyRow, people: People): SocietyResource {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    email: row.email,
    phone:
      row.country_code !== null && row.phone_number !== null
        ? { countryCode: row.country_code, number: row.phone_number }
        : null,
    website: row.website,
    foundedDate: row.founded_date,
    address: { line1: row.address_line_1, line2: row.address_line_2, pincode: row.pincode },
    status: row.status,
    accessPause:
      row.access_paused_at !== null && row.access_pause_reason !== null
        ? {
            pausedAt: row.access_paused_at.toISOString(),
            pausedBy: authorOf(row.access_paused_by, people),
            reason: row.access_pause_reason,
          }
        : null,
    institutionCount: row.institution_count,
    version: row.version,
    ...authorStamps(row, people),
  };
}

export function societySummary(row: SocietyRow, people: People): SocietySummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    paused: row.access_paused_at !== null,
    institutionCount: row.institution_count,
    ...authorStamps(row, people),
  };
}

export function institutionsOf(
  institutions: readonly SocietyInstitution[],
): SocietyDetail['institutions'] {
  return institutions.map(({ id, code, name, status, paused }) => ({
    id,
    code,
    name,
    status,
    paused,
  }));
}
