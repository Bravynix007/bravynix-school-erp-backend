import type { ColumnType, Generated } from 'kysely';

/** Kysely types of the Tenancy tables (DDD 9.3). */

interface Stamps {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  version: Generated<number>;
  /** 1 active, 0 inactive (soft delete, PRD 7.1). */
  status: Generated<number>;
}

export interface SocietiesTable extends Stamps {
  name: string;
  code: string;
  description: string | null;
  email: string | null;
  country_code: string | null;
  phone_number: string | null;
  website: string | null;
  founded_date: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  pincode: string | null;
}

export interface InstitutionsTable extends Stamps {
  society_id: string;
  name: string;
  code: string;
  place: string | null;
  board_code: number | null;
  affiliation_number: string | null;
  gstin: string | null;
  email: string | null;
  country_code: string | null;
  phone_number: string | null;
  telephone: string | null;
  address_line_1: string;
  address_line_2: string | null;
  pincode: string | null;
  /** numeric(9,6), kept as an exact decimal string. */
  latitude: string | null;
  longitude: string | null;
}

/**
 * One block of a section of people (DDD 9.3): `section` 1 owners, 2 staff, 3
 * students. `created_at` and `created_by` are when and by whom it was set.
 * Active while `lifted_at` is empty; lifting keeps the row.
 */
export interface AccessBlocksTable {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  society_id: string;
  institution_id: string | null;
  section: number;
  reason: string;
  lifted_at: ColumnType<Date | null, never, Date>;
  lifted_by: ColumnType<string | null, never, string>;
}
