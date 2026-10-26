import { authorOf, authorStamps, type AuthorStamps } from '../../common/http/author-stamps.js';
import type { Phone } from '../../common/validation/phone.dto.js';
import type { InstitutionRow } from './institution.repository.js';
import type { People } from './society.resource.js';

/** The Institution as the API shows it (API design 10.4c). Every field is present; empty ones are `null`. */
export interface InstitutionResource extends AuthorStamps {
  id: string;
  societyId: string;
  code: string;
  name: string;
  place: string | null;
  boardCode: number | null;
  affiliationNumber: string | null;
  gstin: string | null;
  email: string | null;
  phone: Phone | null;
  telephone: string | null;
  address: { line1: string; line2: string | null; pincode: string | null };
  location: { latitude: number; longitude: number } | null;
  status: number;
  accessPause: ReturnType<typeof accessPauseOf>;
  version: number;
}

/** One row of the INS-01 switcher list. */
export interface InstitutionOption extends AuthorStamps {
  id: string;
  code: string;
  name: string;
  place: string | null;
  boardCode: number | null;
  paused: boolean;
}

/** One row of the PLT-19 list. */
export interface InstitutionSummary extends InstitutionOption {
  societyId: string;
  societyName: string;
  status: number;
}

/** Everyone an Institution row names, for one lookup. */
export function peopleOfInstitutions(rows: readonly InstitutionRow[]): string[] {
  return rows
    .flatMap((row) => [row.created_by, row.updated_by, row.access_paused_by])
    .filter((id): id is string => id !== null);
}

function accessPauseOf(row: InstitutionRow, people: People) {
  return row.access_paused_at !== null && row.access_pause_reason !== null
    ? {
        pausedAt: row.access_paused_at.toISOString(),
        pausedBy: authorOf(row.access_paused_by, people),
        reason: row.access_pause_reason,
      }
    : null;
}

export function institutionResource(row: InstitutionRow, people: People): InstitutionResource {
  return {
    id: row.id,
    societyId: row.society_id,
    code: row.code,
    name: row.name,
    place: row.place,
    boardCode: row.board_code,
    affiliationNumber: row.affiliation_number,
    gstin: row.gstin,
    email: row.email,
    phone:
      row.country_code !== null && row.phone_number !== null
        ? { countryCode: row.country_code, number: row.phone_number }
        : null,
    telephone: row.telephone,
    address: { line1: row.address_line_1, line2: row.address_line_2, pincode: row.pincode },
    location:
      row.latitude !== null && row.longitude !== null
        ? { latitude: Number(row.latitude), longitude: Number(row.longitude) }
        : null,
    status: row.status,
    accessPause: accessPauseOf(row, people),
    version: row.version,
    ...authorStamps(row, people),
  };
}

export function institutionOption(row: InstitutionRow, people: People): InstitutionOption {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    place: row.place,
    boardCode: row.board_code,
    paused: row.access_paused_at !== null,
    ...authorStamps(row, people),
  };
}

export function institutionSummary(row: InstitutionRow, people: People): InstitutionSummary {
  return {
    ...institutionOption(row, people),
    societyId: row.society_id,
    societyName: row.society_name,
    status: row.status,
  };
}
