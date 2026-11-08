import { sql, type Kysely } from 'kysely';

/**
 * People, part 1 (DDD 9.5, PRD 7.5): the staff record and the lists that belong to it.
 *
 * - `staff_members`: one record per person per Society while active (`uq_staff_members_society_user`), with a home
 *   Institution. Employee ID is unique per Institution among active records, ignoring letter case. A person is
 *   deactivated (`status` 0), never deleted, and the Employee ID is then free again.
 * - `staff_educations` and `staff_emergency_contacts`: whole lists, replaced in an edit, so their rows are never
 *   updated and the app role may delete them (the audit entry keeps before and after). At most one primary emergency
 *   contact per person.
 *
 * Staff tables use the Society-level policy (DDD 15.3); the application narrows to the Institutions the caller reaches.
 *
 * Roles 4 and 5 are derived from these records (DDD 9.1, M1), so the two block functions of migration 0011 now also
 * answer for a person who holds an active staff record in the Society: a blocked teacher must be stopped and must be
 * told why, as an Institution Admin is. Guardians join them with their table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table staff_members (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      society_id uuid not null references societies (id) on delete restrict,
      home_institution_id uuid not null,
      user_id uuid not null references users (id) on delete restrict,
      employee_code varchar(50),
      first_name varchar(100) not null,
      last_name varchar(100),
      gender smallint,
      date_of_birth date,
      blood_group varchar(3),
      nationality varchar(50),
      photo_file_id uuid,
      designation_id uuid references designations (id) on delete restrict,
      class_category_id uuid not null references class_categories (id) on delete restrict,
      country_code varchar(4) not null,
      mobile_number varchar(15) not null,
      alternate_phone varchar(15),
      address_line_1 varchar(255),
      address_line_2 varchar(255),
      country_id uuid references countries (id) on delete restrict,
      state_id uuid references states (id) on delete restrict,
      city_id uuid references cities (id) on delete restrict,
      pincode varchar(10),
      joining_date date,
      resignation_date date,
      employment_type smallint,
      constraint fk_staff_members_home_institution foreign key (home_institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_staff_members_photo foreign key (photo_file_id, society_id)
        references files (id, society_id) on delete restrict,
      constraint uq_staff_members_id_society unique (id, society_id),
      constraint uq_staff_members_id_home unique (id, home_institution_id),
      constraint uq_staff_members_id_user unique (id, user_id),
      constraint ck_staff_members_status check (status in (0, 1)),
      constraint ck_staff_members_first_name check (btrim(first_name) <> ''),
      constraint ck_staff_members_code check (employee_code is null or btrim(employee_code) <> ''),
      constraint ck_staff_members_gender check (gender is null or gender in (1, 2, 3)),
      constraint ck_staff_members_blood_group
        check (blood_group is null or blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
      constraint ck_staff_members_employment check (employment_type is null or employment_type in (1, 2, 3, 4)),
      constraint ck_staff_members_resignation
        check (resignation_date is null or joining_date is null or resignation_date >= joining_date),
      constraint ck_staff_members_phone check (country_code ~ '^[0-9]{1,4}$' and mobile_number ~ '^[0-9]{6,15}$'),
      constraint ck_staff_members_alternate check (alternate_phone is null or alternate_phone ~ '^[0-9]{6,15}$')
    )
  `.execute(db);
  await sql`
    create unique index uq_staff_members_home_employee_code
      on staff_members (home_institution_id, lower(employee_code))
      where employee_code is not null and status = 1
  `.execute(db);
  await sql`
    create unique index uq_staff_members_society_user on staff_members (society_id, user_id) where status = 1
  `.execute(db);
  // A photo belongs to one person; a second record pointing at it is refused.
  await sql`
    create unique index uq_staff_members_photo on staff_members (photo_file_id) where photo_file_id is not null
  `.execute(db);
  await sql`
    create index ix_staff_members_home on staff_members (home_institution_id) where status = 1
  `.execute(db);
  await sql`
    create trigger trg_staff_members_updated before update on staff_members
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_staff_members_version before update on staff_members
      for each row execute function bump_version()
  `.execute(db);

  await sql`
    create table staff_educations (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      society_id uuid not null,
      staff_member_id uuid not null,
      degree varchar(100) not null,
      qualification varchar(100),
      specialization varchar(100),
      institution_name varchar(200),
      year_of_passing smallint,
      constraint fk_staff_educations_staff foreign key (staff_member_id, society_id)
        references staff_members (id, society_id) on delete restrict,
      constraint ck_staff_educations_degree check (btrim(degree) <> ''),
      constraint ck_staff_educations_year check (year_of_passing is null or year_of_passing between 1900 and 2200)
    )
  `.execute(db);
  await sql`create index ix_staff_educations_staff on staff_educations (staff_member_id)`.execute(
    db,
  );

  await sql`
    create table staff_emergency_contacts (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      society_id uuid not null,
      staff_member_id uuid not null,
      contact_name varchar(100) not null,
      relation varchar(50),
      country_code varchar(4) not null,
      phone_number varchar(15) not null,
      alternate_phone varchar(15),
      is_primary boolean not null default false,
      constraint fk_staff_emergency_contacts_staff foreign key (staff_member_id, society_id)
        references staff_members (id, society_id) on delete restrict,
      constraint ck_staff_emergency_contacts_name check (btrim(contact_name) <> ''),
      constraint ck_staff_emergency_contacts_phone
        check (country_code ~ '^[0-9]{1,4}$' and phone_number ~ '^[0-9]{6,15}$'),
      constraint ck_staff_emergency_contacts_alternate
        check (alternate_phone is null or alternate_phone ~ '^[0-9]{6,15}$')
    )
  `.execute(db);
  await sql`
    create index ix_staff_emergency_contacts_staff on staff_emergency_contacts (staff_member_id)
  `.execute(db);
  await sql`
    create unique index uq_staff_emergency_contacts_primary
      on staff_emergency_contacts (staff_member_id) where is_primary
  `.execute(db);

  for (const table of ['staff_members', 'staff_educations', 'staff_emergency_contacts']) {
    const t = sql.table(table);
    const policy = (suffix: string) => sql.id(`${table}_${suffix}`);
    await sql`alter table ${t} enable row level security`.execute(db);
    await sql`alter table ${t} force row level security`.execute(db);
    await sql`create policy ${policy('select')} on ${t} for select using (society_id = app_current_society_id())`.execute(
      db,
    );
    await sql`create policy ${policy('insert')} on ${t} for insert with check (society_id = app_current_society_id())`.execute(
      db,
    );
  }
  await sql`
    create policy staff_members_update on staff_members for update
      using (society_id = app_current_society_id()) with check (society_id = app_current_society_id())
  `.execute(db);
  await sql`
    create policy staff_educations_delete on staff_educations for delete
      using (society_id = app_current_society_id())
  `.execute(db);
  await sql`
    create policy staff_emergency_contacts_delete on staff_emergency_contacts for delete
      using (society_id = app_current_society_id())
  `.execute(db);
  // A staff record is deactivated, never deleted; its two lists are only ever replaced whole.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table staff_members from erp_app;
        revoke update, truncate on table staff_educations, staff_emergency_contacts from erp_app;
      end if;
    end;
    $$
  `.execute(db);

  await replaceBlockFunctions(db, true);
}

/**
 * The two definer functions of migration 0011, answering for a person who holds a grant or, from now on, an active
 * staff record in the Society. `withStaff` false restores the earlier bodies.
 */
async function replaceBlockFunctions(db: Kysely<unknown>, withStaff: boolean): Promise<void> {
  const member = (society: string, person: string) =>
    withStaff
      ? sql.raw(`
          or exists (
            select 1 from staff_members m
            where m.user_id = ${person} and m.society_id = ${society} and m.status = 1
          )`)
      : sql.raw('');
  await sql`
    create or replace function app_active_blocks(society uuid, person uuid)
      returns table (section smallint, institution_id uuid)
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
    begin
      perform set_config('app.role_code', '1', true);
      return query
        select b.section, b.institution_id from access_blocks b
        where b.society_id = society and b.lifted_at is null
          and (
            exists (
              select 1 from role_assignments g
              where g.user_id = person and g.society_id = society and g.revoked_at is null
            )
            ${member('society', 'person')}
          );
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
    end;
    $$
  `.execute(db);
  await sql`
    create or replace function app_society_name(society uuid, person uuid) returns text
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      found_name text;
    begin
      perform set_config('app.role_code', '1', true);
      select s.name into found_name from societies s
      where s.id = society
        and (
          exists (
            select 1 from role_assignments g
            where g.user_id = person and g.society_id = society and g.revoked_at is null
          )
          ${member('society', 'person')}
        );
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      return found_name;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): later tables refer to the staff record.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop staff_members in production: later tables refer to it');
  }
  await replaceBlockFunctions(db, false);
  await sql`drop table if exists staff_emergency_contacts`.execute(db);
  await sql`drop table if exists staff_educations`.execute(db);
  await sql`drop table if exists staff_members`.execute(db);
}
