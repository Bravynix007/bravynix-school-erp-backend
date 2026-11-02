import {
  CreateCityDto,
  CreateClassCategoryDto,
  CreateCountryDto,
  CreateDesignationDto,
  CreatePredefinedClassDto,
  CreatePredefinedSectionDto,
  CreateStateDto,
  UpdateCityDto,
  UpdateClassCategoryDto,
  UpdateCountryDto,
  UpdateDesignationDto,
  UpdatePredefinedClassDto,
  UpdatePredefinedSectionDto,
  UpdateStateDto,
} from './master.dto.js';

/** The masters, as they are named in the path (`/v1/masters/{masterType}`, API design 10.4g). */
export const MASTER_TYPES = [
  'countries',
  'states',
  'cities',
  'class-categories',
  'predefined-classes',
  'predefined-sections',
  'designations',
] as const;

export type MasterType = (typeof MASTER_TYPES)[number];

export function isMasterType(value: string): value is MasterType {
  return (MASTER_TYPES as readonly string[]).includes(value);
}

export type MasterTable =
  | 'countries'
  | 'states'
  | 'cities'
  | 'class_categories'
  | 'predefined_classes'
  | 'predefined_sections'
  | 'designations';

/** One field of an entry: its name in the API and its column. */
export interface MasterField {
  api: string;
  column: string;
}

/** What one master is, in one place, so the seven share one repository, service and pair of controllers. */
export interface MasterSpec {
  type: MasterType;
  table: MasterTable;
  /** The audit entry's entity type. */
  entity: string;
  /** The fields an entry shows, besides `id`, `status` and `version`. */
  fields: readonly MasterField[];
  /** The body of PLT-31 and of PLT-32. */
  create: new () => object;
  update: new () => object;
  /** The list is in the order of `display_order`, or by name for the places. */
  ordered: boolean;
  /** The unique constraint on `display_order`, deferred while entries shift. */
  orderConstraint?: string;
  /** The entry this one belongs to, which is fixed once the entry is added. */
  parent?: { field: string; column: string; table: MasterTable };
  /** The query filters MST-01 takes; the one named `required` has to be given. */
  filters: readonly (MasterField & { required?: boolean })[];
  /** A unique constraint (or the start of its name) and the field it protects. */
  duplicates: readonly { constraint: string; field: string }[];
}

const field = (api: string, column: string): MasterField => ({ api, column });

export const MASTER_SPECS: Readonly<Record<MasterType, MasterSpec>> = {
  countries: {
    type: 'countries',
    table: 'countries',
    entity: 'country',
    fields: [
      field('name', 'name'),
      field('iso2', 'iso2'),
      field('phoneCode', 'phone_code'),
      field('currency', 'currency'),
    ],
    create: CreateCountryDto,
    update: UpdateCountryDto,
    ordered: false,
    filters: [],
    duplicates: [
      { constraint: 'uq_countries_iso2', field: 'iso2' },
      { constraint: 'uq_countries_name', field: 'name' },
    ],
  },
  states: {
    type: 'states',
    table: 'states',
    entity: 'state',
    fields: [field('countryId', 'country_id'), field('name', 'name'), field('iso2', 'iso2')],
    create: CreateStateDto,
    update: UpdateStateDto,
    ordered: false,
    parent: { field: 'countryId', column: 'country_id', table: 'countries' },
    filters: [field('countryId', 'country_id')],
    duplicates: [
      { constraint: 'uq_states_country_iso2', field: 'iso2' },
      { constraint: 'uq_states_country_name', field: 'name' },
    ],
  },
  cities: {
    type: 'cities',
    table: 'cities',
    entity: 'city',
    fields: [field('stateId', 'state_id'), field('name', 'name')],
    create: CreateCityDto,
    update: UpdateCityDto,
    ordered: false,
    parent: { field: 'stateId', column: 'state_id', table: 'states' },
    filters: [{ ...field('stateId', 'state_id'), required: true }],
    duplicates: [{ constraint: 'uq_cities_state_name', field: 'name' }],
  },
  'class-categories': {
    type: 'class-categories',
    table: 'class_categories',
    entity: 'class_category',
    fields: [field('code', 'code'), field('name', 'name'), field('displayOrder', 'display_order')],
    create: CreateClassCategoryDto,
    update: UpdateClassCategoryDto,
    ordered: true,
    filters: [],
    duplicates: [
      { constraint: 'uq_class_categories_code', field: 'code' },
      { constraint: 'uq_class_categories_name', field: 'name' },
    ],
  },
  'predefined-classes': {
    type: 'predefined-classes',
    table: 'predefined_classes',
    entity: 'predefined_class',
    fields: [
      field('classCategoryId', 'class_category_id'),
      field('code', 'code'),
      field('name', 'name'),
      field('numericValue', 'numeric_value'),
      field('displayOrder', 'display_order'),
    ],
    create: CreatePredefinedClassDto,
    update: UpdatePredefinedClassDto,
    ordered: true,
    orderConstraint: 'uq_predefined_classes_display_order',
    parent: { field: 'classCategoryId', column: 'class_category_id', table: 'class_categories' },
    filters: [field('classCategoryId', 'class_category_id')],
    duplicates: [
      { constraint: 'uq_predefined_classes_code', field: 'code' },
      { constraint: 'uq_predefined_classes_name', field: 'name' },
    ],
  },
  'predefined-sections': {
    type: 'predefined-sections',
    table: 'predefined_sections',
    entity: 'predefined_section',
    fields: [field('code', 'code'), field('name', 'name'), field('displayOrder', 'display_order')],
    create: CreatePredefinedSectionDto,
    update: UpdatePredefinedSectionDto,
    ordered: true,
    orderConstraint: 'uq_predefined_sections_display_order',
    filters: [],
    duplicates: [
      { constraint: 'uq_predefined_sections_code', field: 'code' },
      { constraint: 'uq_predefined_sections_name', field: 'name' },
    ],
  },
  designations: {
    type: 'designations',
    table: 'designations',
    entity: 'designation',
    fields: [field('code', 'code'), field('name', 'name'), field('displayOrder', 'display_order')],
    create: CreateDesignationDto,
    update: UpdateDesignationDto,
    ordered: true,
    filters: [],
    duplicates: [
      { constraint: 'uq_designations_code', field: 'code' },
      { constraint: 'uq_designations_name', field: 'name' },
    ],
  },
};
