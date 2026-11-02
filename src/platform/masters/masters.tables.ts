import type { ColumnType, Generated } from 'kysely';

/** Kysely types of the platform masters (DDD 9.2). Global lists: no Society or Institution column. */

interface Stamps {
  id: Generated<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  created_by: string | null;
  updated_at: ColumnType<Date, never, Date>;
  updated_by: string | null;
  version: Generated<number>;
  /** 1 shown, 0 hidden from pickers (nothing is deleted). */
  status: Generated<number>;
}

export interface CountriesTable extends Stamps {
  name: string;
  iso2: string;
  phone_code: string | null;
  currency: string | null;
}

export interface StatesTable extends Stamps {
  country_id: string;
  name: string;
  iso2: string | null;
}

export interface CitiesTable extends Stamps {
  state_id: string;
  name: string;
}

export interface ClassCategoriesTable extends Stamps {
  code: string;
  name: string;
  display_order: number;
}

export interface PredefinedClassesTable extends Stamps {
  class_category_id: string;
  name: string;
  code: string;
  numeric_value: number | null;
  display_order: number;
}

export interface PredefinedSectionsTable extends Stamps {
  name: string;
  code: string;
  display_order: number;
}

export interface DesignationsTable extends Stamps {
  name: string;
  code: string;
  display_order: number;
}
