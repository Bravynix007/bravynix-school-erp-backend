import { authorStamps, type AuthorStamps } from '../../common/http/author-stamps.js';
import type { Phone } from '../../common/validation/phone.dto.js';
import type { InstitutionListRow, InstitutionRow } from './institution.repository.js';
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
  version: number;
}

/** One row of the INS-01 switcher list. */
export interface InstitutionOption extends AuthorStamps {
  id: string;
  code: string;
  name: string;
  place: string | null;
  boardCode: number | null;
}

/** One row of the PLT-19 list: the sections of the Institution that are blocked. */
export interface InstitutionSummary extends InstitutionOption {
  societyId: string;
  societyName: string;
  status: number;
  blockedSections: ('staff' | 'students')[];
}

/** Everyone an Institution row names, for one lookup. */
export function peopleOfInstitutions(rows: readonly InstitutionRow[]): string[] {
  return rows
    .flatMap((row) => [row.created_by, row.updated_by])
    .filter((id): id is string => id !== null);
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
    ...authorStamps(row, people),
  };
}

export function institutionSummary(row: InstitutionListRow, people: People): InstitutionSummary {
  return {
    ...institutionOption(row, people),
    societyId: row.society_id,
    societyName: row.society_name,
    status: row.status,
    blockedSections: [
      ...(row.staff_blocked ? (['staff'] as const) : []),
      ...(row.students_blocked ? (['students'] as const) : []),
    ],
  };
}
