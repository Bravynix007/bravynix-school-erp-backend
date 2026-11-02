import { sql, type Kysely } from 'kysely';

/**
 * Platform masters (DDD 9.2): the shared lists every Institution picks from.
 * Countries, states, cities, class categories, predefined classes and
 * sections, and designations. Global: no Society or Institution column.
 * Everyone reads them; only Super Admin writes (a policy, because the API
 * connects as one database user and decides who the caller is).
 *
 * Fixes compared with the old schema (DDD 9.2): a predefined class must have a
 * category, `predefined_subjects` is not built (subjects are per Society), and
 * the board is a code list on the Institution.
 *
 * Additions to the DDD, written back into it: a case-insensitive name is unique
 * in its parent (places) or its table (the lists), a `code` is upper case, and
 * the order columns of the two lists that promotion walks are DEFERRABLE, so an
 * entry can be moved by shifting the ones between in one statement. The
 * `ix_states_country` and `ix_cities_state` indexes are the leading column of
 * the unique name index, so they are not repeated.
 *
 * The data is seeded here, before row-level security is switched on, because
 * every environment needs it, not only the demo: the seven class categories of
 * the Indian school system (owner decision, 2 Nov 2026), their classes, the
 * sections A to J, the designations, and India with its states, union
 * territories and main cities (India only for now, owner decision).
 */

const STANDARD = `
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id),
  version integer not null default 1,
  status smallint not null default 1
`;

const TABLES = [
  'countries',
  'states',
  'cities',
  'class_categories',
  'predefined_classes',
  'predefined_sections',
  'designations',
] as const;

const CLASS_CATEGORIES: readonly (readonly [code: string, name: string])[] = [
  ['PRE_SCHOOL', 'Pre-School'],
  ['NURSERY', 'Nursery'],
  ['LOWER_PRIMARY', 'Lower Primary'],
  ['HIGHER_PRIMARY', 'Higher Primary'],
  ['HIGH_SCHOOL', 'High School'],
  ['SENIOR_SECONDARY', 'Senior Secondary'],
  ['PRE_UNIVERSITY', 'Pre-University'],
];

/** In promotion order; `numeric` is the class number where there is one. */
const PREDEFINED_CLASSES: readonly (readonly [
  category: string,
  code: string,
  name: string,
  numeric: number | null,
])[] = [
  ['PRE_SCHOOL', 'NUR', 'Nursery', null],
  ['NURSERY', 'LKG', 'LKG', null],
  ['NURSERY', 'UKG', 'UKG', null],
  ['LOWER_PRIMARY', 'C01', '1st', 1],
  ['LOWER_PRIMARY', 'C02', '2nd', 2],
  ['LOWER_PRIMARY', 'C03', '3rd', 3],
  ['LOWER_PRIMARY', 'C04', '4th', 4],
  ['HIGHER_PRIMARY', 'C05', '5th', 5],
  ['HIGHER_PRIMARY', 'C06', '6th', 6],
  ['HIGHER_PRIMARY', 'C07', '7th', 7],
  ['HIGHER_PRIMARY', 'C08', '8th', 8],
  ['HIGH_SCHOOL', 'C09', '9th', 9],
  ['HIGH_SCHOOL', 'C10', '10th', 10],
  ['SENIOR_SECONDARY', 'C11', '11th', 11],
  ['SENIOR_SECONDARY', 'C12', '12th', 12],
  ['PRE_UNIVERSITY', 'PUC1', 'PUC 1st Year', null],
  ['PRE_UNIVERSITY', 'PUC2', 'PUC 2nd Year', null],
];

const SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

const DESIGNATIONS: readonly (readonly [code: string, name: string])[] = [
  ['PRINCIPAL', 'Principal'],
  ['VICE_PRINCIPAL', 'Vice Principal'],
  ['HEADMASTER', 'Headmaster'],
  ['HEADMISTRESS', 'Headmistress'],
  ['COORDINATOR', 'Coordinator'],
  ['TEACHER', 'Teacher'],
  ['PE_TEACHER', 'Physical Education Teacher'],
  ['ACCOUNTANT', 'Accountant'],
  ['CLERK', 'Clerk'],
  ['LIBRARIAN', 'Librarian'],
  ['LAB_ASSISTANT', 'Lab Assistant'],
  ['OFFICE_ASSISTANT', 'Office Assistant'],
];

/** States and union territories with their ISO 3166-2:IN code, and the main cities of each. */
const PLACES: readonly (readonly [state: string, iso2: string, cities: readonly string[]])[] = [
  ['Andhra Pradesh', 'AP', ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Tirupati', 'Amaravati']],
  ['Arunachal Pradesh', 'AR', ['Itanagar']],
  ['Assam', 'AS', ['Guwahati', 'Dibrugarh', 'Silchar']],
  ['Bihar', 'BR', ['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur']],
  ['Chhattisgarh', 'CG', ['Raipur', 'Bhilai', 'Bilaspur']],
  ['Goa', 'GA', ['Panaji', 'Margao']],
  ['Gujarat', 'GJ', ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Gandhinagar']],
  ['Haryana', 'HR', ['Gurugram', 'Faridabad', 'Panipat', 'Ambala']],
  ['Himachal Pradesh', 'HP', ['Shimla', 'Dharamshala', 'Mandi', 'Solan']],
  ['Jharkhand', 'JH', ['Ranchi', 'Jamshedpur', 'Dhanbad']],
  [
    'Karnataka',
    'KA',
    [
      'Bengaluru',
      'Mysuru',
      'Hubballi',
      'Mangaluru',
      'Belagavi',
      'Kalaburagi',
      'Davanagere',
      'Ballari',
      'Shivamogga',
      'Tumakuru',
    ],
  ],
  ['Kerala', 'KL', ['Thiruvananthapuram', 'Kochi', 'Kozhikode', 'Thrissur', 'Kollam']],
  ['Madhya Pradesh', 'MP', ['Bhopal', 'Indore', 'Gwalior', 'Jabalpur']],
  [
    'Maharashtra',
    'MH',
    ['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Thane', 'Chhatrapati Sambhajinagar'],
  ],
  ['Manipur', 'MN', ['Imphal']],
  ['Meghalaya', 'ML', ['Shillong']],
  ['Mizoram', 'MZ', ['Aizawl']],
  ['Nagaland', 'NL', ['Kohima', 'Dimapur']],
  ['Odisha', 'OD', ['Bhubaneswar', 'Cuttack', 'Rourkela']],
  ['Punjab', 'PB', ['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala']],
  ['Rajasthan', 'RJ', ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota']],
  ['Sikkim', 'SK', ['Gangtok']],
  ['Tamil Nadu', 'TN', ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem']],
  ['Telangana', 'TS', ['Hyderabad', 'Warangal', 'Karimnagar']],
  ['Tripura', 'TR', ['Agartala']],
  [
    'Uttar Pradesh',
    'UP',
    ['Lucknow', 'Kanpur', 'Varanasi', 'Agra', 'Noida', 'Prayagraj', 'Ghaziabad'],
  ],
  ['Uttarakhand', 'UK', ['Dehradun', 'Haridwar']],
  ['West Bengal', 'WB', ['Kolkata', 'Howrah', 'Siliguri', 'Durgapur']],
  ['Andaman and Nicobar Islands', 'AN', ['Port Blair']],
  ['Chandigarh', 'CH', ['Chandigarh']],
  ['Dadra and Nagar Haveli and Daman and Diu', 'DH', ['Daman', 'Silvassa']],
  ['Delhi', 'DL', ['New Delhi', 'Delhi']],
  ['Jammu and Kashmir', 'JK', ['Srinagar', 'Jammu']],
  ['Ladakh', 'LA', ['Leh']],
  ['Lakshadweep', 'LD', ['Kavaratti']],
  ['Puducherry', 'PY', ['Puducherry']],
];

async function seed(db: Kysely<unknown>): Promise<void> {
  await sql`
    insert into countries (name, iso2, phone_code, currency) values ('India', 'IN', '91', 'INR')
  `.execute(db);
  for (const [state, iso2, cities] of PLACES) {
    await sql`
      insert into states (country_id, name, iso2)
      select id, ${state}, ${iso2} from countries where iso2 = 'IN'
    `.execute(db);
    for (const city of cities) {
      await sql`
        insert into cities (state_id, name)
        select id, ${city} from states where iso2 = ${iso2}
      `.execute(db);
    }
  }
  for (const [index, [code, name]] of CLASS_CATEGORIES.entries()) {
    await sql`
      insert into class_categories (code, name, display_order) values (${code}, ${name}, ${index + 1})
    `.execute(db);
  }
  for (const [index, [category, code, name, numeric]] of PREDEFINED_CLASSES.entries()) {
    await sql`
      insert into predefined_classes (class_category_id, code, name, numeric_value, display_order)
      select id, ${code}, ${name}, ${numeric}, ${index + 1} from class_categories where code = ${category}
    `.execute(db);
  }
  for (const [index, name] of SECTIONS.entries()) {
    await sql`
      insert into predefined_sections (code, name, display_order) values (${name}, ${name}, ${index + 1})
    `.execute(db);
  }
  for (const [index, [code, name]] of DESIGNATIONS.entries()) {
    await sql`
      insert into designations (code, name, display_order) values (${code}, ${name}, ${index + 1})
    `.execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table countries (
      ${sql.raw(STANDARD)},
      name varchar(100) not null,
      iso2 char(2) not null,
      phone_code varchar(5),
      currency char(3),
      constraint uq_countries_iso2 unique (iso2),
      constraint ck_countries_status check (status in (0, 1)),
      constraint ck_countries_name check (btrim(name) <> ''),
      constraint ck_countries_iso2 check (iso2 ~ '^[A-Z]{2}$'),
      constraint ck_countries_phone_code check (phone_code ~ '^[0-9]{1,5}$'),
      constraint ck_countries_currency check (currency ~ '^[A-Z]{3}$')
    )
  `.execute(db);
  await sql`create unique index uq_countries_name on countries (lower(name))`.execute(db);

  await sql`
    create table states (
      ${sql.raw(STANDARD)},
      country_id uuid not null references countries (id) on delete restrict,
      name varchar(100) not null,
      iso2 varchar(5),
      constraint ck_states_status check (status in (0, 1)),
      constraint ck_states_name check (btrim(name) <> ''),
      constraint ck_states_iso2 check (iso2 ~ '^[A-Z0-9]{1,5}$')
    )
  `.execute(db);
  await sql`
    create unique index uq_states_country_iso2 on states (country_id, iso2) where iso2 is not null
  `.execute(db);
  await sql`create unique index uq_states_country_name on states (country_id, lower(name))`.execute(
    db,
  );

  await sql`
    create table cities (
      ${sql.raw(STANDARD)},
      state_id uuid not null references states (id) on delete restrict,
      name varchar(120) not null,
      constraint ck_cities_status check (status in (0, 1)),
      constraint ck_cities_name check (btrim(name) <> '')
    )
  `.execute(db);
  await sql`create unique index uq_cities_state_name on cities (state_id, lower(name))`.execute(db);

  await sql`
    create table class_categories (
      ${sql.raw(STANDARD)},
      code varchar(30) not null,
      name varchar(60) not null,
      display_order smallint not null,
      constraint uq_class_categories_code unique (code),
      constraint ck_class_categories_status check (status in (0, 1)),
      constraint ck_class_categories_code check (code ~ '^[A-Z][A-Z0-9_]*$'),
      constraint ck_class_categories_name check (btrim(name) <> ''),
      constraint ck_class_categories_order check (display_order >= 1)
    )
  `.execute(db);
  await sql`create unique index uq_class_categories_name on class_categories (lower(name))`.execute(
    db,
  );

  await sql`
    create table predefined_classes (
      ${sql.raw(STANDARD)},
      class_category_id uuid not null references class_categories (id) on delete restrict,
      name varchar(50) not null,
      code varchar(20) not null,
      numeric_value smallint,
      display_order integer not null,
      constraint uq_predefined_classes_code unique (code),
      constraint uq_predefined_classes_display_order unique (display_order)
        deferrable initially immediate,
      constraint uq_predefined_classes_id_category unique (id, class_category_id),
      constraint ck_predefined_classes_status check (status in (0, 1)),
      constraint ck_predefined_classes_code check (code ~ '^[A-Z][A-Z0-9_]*$'),
      constraint ck_predefined_classes_name check (btrim(name) <> ''),
      constraint ck_predefined_classes_numeric check (numeric_value between 0 and 99),
      constraint ck_predefined_classes_order check (display_order >= 1)
    )
  `.execute(db);
  await sql`create unique index uq_predefined_classes_name on predefined_classes (lower(name))`.execute(
    db,
  );

  await sql`
    create table predefined_sections (
      ${sql.raw(STANDARD)},
      name varchar(10) not null,
      code varchar(10) not null,
      display_order smallint not null,
      constraint uq_predefined_sections_code unique (code),
      constraint uq_predefined_sections_display_order unique (display_order)
        deferrable initially immediate,
      constraint ck_predefined_sections_status check (status in (0, 1)),
      constraint ck_predefined_sections_code check (code ~ '^[A-Z0-9][A-Z0-9_]*$'),
      constraint ck_predefined_sections_name check (btrim(name) <> ''),
      constraint ck_predefined_sections_order check (display_order >= 1)
    )
  `.execute(db);
  await sql`create unique index uq_predefined_sections_name on predefined_sections (lower(name))`.execute(
    db,
  );

  await sql`
    create table designations (
      ${sql.raw(STANDARD)},
      name varchar(60) not null,
      code varchar(30) not null,
      display_order smallint not null,
      constraint uq_designations_code unique (code),
      constraint ck_designations_status check (status in (0, 1)),
      constraint ck_designations_code check (code ~ '^[A-Z][A-Z0-9_]*$'),
      constraint ck_designations_name check (btrim(name) <> ''),
      constraint ck_designations_order check (display_order >= 1)
    )
  `.execute(db);
  await sql`create unique index uq_designations_name on designations (lower(name))`.execute(db);

  for (const table of TABLES) {
    await sql`
      create trigger ${sql.raw(`trg_${table}_updated`)} before update on ${sql.table(table)}
        for each row execute function set_updated_at()
    `.execute(db);
    await sql`
      create trigger ${sql.raw(`trg_${table}_version`)} before update on ${sql.table(table)}
        for each row execute function bump_version()
    `.execute(db);
  }

  // Before row-level security, which would refuse the owner's inserts too.
  await seed(db);

  // Public reference data: everyone reads, only Super Admin writes, nobody deletes.
  for (const table of TABLES) {
    const t = sql.table(table);
    await sql`alter table ${t} enable row level security`.execute(db);
    await sql`alter table ${t} force row level security`.execute(db);
    await sql`create policy ${sql.raw(`${table}_select`)} on ${t} for select using (true)`.execute(
      db,
    );
    await sql`
      create policy ${sql.raw(`${table}_insert`)} on ${t} for insert
        with check (app_is_super_admin())
    `.execute(db);
    await sql`
      create policy ${sql.raw(`${table}_update`)} on ${t} for update
        using (app_is_super_admin()) with check (app_is_super_admin())
    `.execute(db);
  }
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table countries, states, cities, class_categories,
          predefined_classes, predefined_sections, designations from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6); other tables will point at these rows.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the platform masters in production: rows refer to them');
  }
  for (const table of TABLES.toReversed()) {
    await sql`drop table if exists ${sql.table(table)}`.execute(db);
  }
}
