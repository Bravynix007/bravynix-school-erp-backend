import { authorStamps, type AuthorStamps } from '../../common/http/author-stamps.js';
import type { ClassCategoryRef } from '../masters/index.js';
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
  address: {
    line1: string;
    line2: string | null;
    pincode: string | null;
    countryId: string | null;
    stateId: string | null;
    cityId: string | null;
  };
  location: { latitude: number; longitude: number } | null;
  status: number;
  version: number;
}

/**
 * The Institution as its Society sees it (INS-02 to INS-04): the resource and the class categories it offers, in
 * the order of the master list. Super Admin sees the same in PLT-45.
 */
export interface InstitutionDetail extends InstitutionResource {
  classesOffered: ClassCategoryRef[];
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
  /** 1 active, 0 deactivated, so a picker can leave out the Institutions of a deactivated Society. */
  societyStatus: number;
  status: number;
  blockedSections: ('staff' | 'students')[];
}

/** One Institution as Super Admin sees it (PLT-45): the resource, with its Society's name and its blocked sections. */
export interface PlatformInstitution extends InstitutionDetail {
  societyName: string;
  /** 1 active, 0 deactivated: the Institution's own `status` stays 1 when its Society is deactivated. */
  societyStatus: number;
  blockedSections: ('staff' | 'students')[];
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
    address: {
      line1: row.address_line_1,
      line2: row.address_line_2,
      pincode: row.pincode,
      countryId: row.country_id,
      stateId: row.state_id,
      cityId: row.city_id,
    },
    location:
      row.latitude !== null && row.longitude !== null
        ? { latitude: Number(row.latitude), longitude: Number(row.longitude) }
        : null,
    status: row.status,
    version: row.version,
    ...authorStamps(row, people),
  };
}

export function institutionDetail(
  row: InstitutionRow,
  people: People,
  classesOffered: ClassCategoryRef[],
): InstitutionDetail {
  return { ...institutionResource(row, people), classesOffered };
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

function blockedSectionsOf(row: InstitutionListRow): ('staff' | 'students')[] {
  return [
    ...(row.staff_blocked ? (['staff'] as const) : []),
    ...(row.students_blocked ? (['students'] as const) : []),
  ];
}

export function institutionSummary(row: InstitutionListRow, people: People): InstitutionSummary {
  return {
    ...institutionOption(row, people),
    societyId: row.society_id,
    societyName: row.society_name,
    societyStatus: row.society_status,
    status: row.status,
    blockedSections: blockedSectionsOf(row),
  };
}

export function platformInstitution(
  row: InstitutionListRow,
  people: People,
  classesOffered: ClassCategoryRef[],
): PlatformInstitution {
  return {
    ...institutionDetail(row, people, classesOffered),
    societyName: row.society_name,
    societyStatus: row.society_status,
    blockedSections: blockedSectionsOf(row),
  };
}
