import { sql, type Kysely } from 'kysely';

/**
 * Tenancy, part 1 (DDD 9.3): `societies` and `institutions`, the two tenant
 * roots, with row-level security (DDD 15.3 "Tenant roots").
 *
 * Both tables are soft-delete (`status` 0 or 1) and versioned. Nothing deletes
 * them: the app role has no DELETE right and every foreign key into them is
 * RESTRICT (finding F-08). The logo, country, state and city columns join with
 * the masters and files tables.
 *
 * The access pause (PRD 9.4) is three columns that are all set or all empty.
 * Only Super Admin may change them; a trigger enforces that below the
 * application, because the policy that lets a Society Owner edit their own
 * profile cannot tell columns apart.
 *
 * This migration also adds the foreign keys that earlier migrations waited
 * for: `role_assignments` to the Society and, as a composite key, to the
 * Institution (so a grant can never name an Institution of another Society),
 * and `auth_sessions.active_society_id` to the Society.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table societies (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      name varchar(255) not null,
      code varchar(50) not null,
      description varchar(1000),
      email varchar(254),
      country_code varchar(4),
      phone_number varchar(15),
      website varchar(255),
      founded_date date,
      address_line_1 varchar(255),
      address_line_2 varchar(255),
      pincode varchar(10),
      access_paused_at timestamptz,
      access_paused_by uuid references users (id),
      access_pause_reason varchar(500),
      constraint uq_societies_code unique (code),
      constraint ck_societies_status check (status in (0, 1)),
      constraint ck_societies_name check (btrim(name) <> ''),
      constraint ck_societies_code check (btrim(code) <> ''),
      constraint ck_societies_email check (email = lower(email)),
      constraint ck_societies_country_code check (country_code ~ '^[0-9]{1,4}$'),
      constraint ck_societies_phone_number check (phone_number ~ '^[0-9]{6,15}$'),
      constraint ck_societies_phone_pair check ((country_code is null) = (phone_number is null)),
      constraint ck_societies_website check (website ~* '^https?://'),
      constraint ck_societies_pause check (
        (access_paused_at is null) = (access_paused_by is null)
        and (access_paused_at is null) = (access_pause_reason is null)
      )
    )
  `.execute(db);

  await sql`
    create table institutions (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      society_id uuid not null references societies (id) on delete restrict,
      name varchar(255) not null,
      code varchar(50) not null,
      place varchar(100),
      board_code smallint,
      affiliation_number varchar(50),
      gstin varchar(15),
      email varchar(254),
      country_code varchar(4),
      phone_number varchar(15),
      telephone varchar(20),
      address_line_1 varchar(255) not null,
      address_line_2 varchar(255),
      pincode varchar(10),
      latitude numeric(9, 6),
      longitude numeric(9, 6),
      access_paused_at timestamptz,
      access_paused_by uuid references users (id),
      access_pause_reason varchar(500),
      constraint uq_institutions_id_society unique (id, society_id),
      constraint ck_institutions_status check (status in (0, 1)),
      constraint ck_institutions_name check (btrim(name) <> ''),
      constraint ck_institutions_code check (btrim(code) <> ''),
      constraint ck_institutions_address check (btrim(address_line_1) <> ''),
      constraint ck_institutions_board check (board_code between 1 and 6),
      constraint ck_institutions_gstin
        check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
      constraint ck_institutions_email check (email = lower(email)),
      constraint ck_institutions_country_code check (country_code ~ '^[0-9]{1,4}$'),
      constraint ck_institutions_phone_number check (phone_number ~ '^[0-9]{6,15}$'),
      constraint ck_institutions_phone_pair check ((country_code is null) = (phone_number is null)),
      constraint ck_institutions_latitude check (latitude between -90 and 90),
      constraint ck_institutions_longitude check (longitude between -180 and 180),
      constraint ck_institutions_pause check (
        (access_paused_at is null) = (access_paused_by is null)
        and (access_paused_at is null) = (access_pause_reason is null)
      )
    )
  `.execute(db);
  // Unique within the Society, ignoring case (PRD 7.1). Also serves the
  // per-Society list, so the RLS test on society_id uses it.
  await sql`create unique index uq_institutions_society_code on institutions (society_id, lower(code))`.execute(
    db,
  );

  for (const table of ['societies', 'institutions']) {
    await sql`
      create trigger ${sql.raw(`trg_${table}_updated`)} before update on ${sql.table(table)}
        for each row execute function set_updated_at()
    `.execute(db);
    await sql`
      create trigger ${sql.raw(`trg_${table}_version`)} before update on ${sql.table(table)}
        for each row execute function bump_version()
    `.execute(db);
  }

  // Only Super Admin pauses or resumes access (on insert as well as update, so
  // no row is created already paused), and only Super Admin sets a Society's
  // code or activates and deactivates it (PRD 3.1). An Institution's status
  // stays editable by its Society (PRD 7.1). Migrations and seeds insert rows
  // with no pause set.
  await sql`
    create function tenancy_guard_platform_columns() returns trigger
    language plpgsql as $$
    begin
      if not app_is_super_admin() and (
        new.access_paused_at is distinct from old.access_paused_at
        or new.access_paused_by is distinct from old.access_paused_by
        or new.access_pause_reason is distinct from old.access_pause_reason
        or (
          tg_op = 'UPDATE' and tg_table_name = 'societies'
          and (new.code is distinct from old.code or new.status is distinct from old.status)
        )
      ) then
        raise exception 'Only Super Admin may change % pause, status or code', tg_table_name
          using errcode = '42501';
      end if;
      return new;
    end;
    $$
  `.execute(db);
  for (const table of ['societies', 'institutions']) {
    await sql`
      create trigger ${sql.raw(`trg_${table}_platform_columns`)} before insert or update on ${sql.table(table)}
        for each row execute function tenancy_guard_platform_columns()
    `.execute(db);
  }

  // Row-level security (DDD 15.3). A Society sees itself and its Institutions;
  // Super Admin sees every row. A request with no tenant set sees nothing,
  // because the helper functions then return NULL and NULL is never equal.
  for (const table of ['societies', 'institutions']) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.table(table)} force row level security`.execute(db);
  }
  await sql`
    create policy societies_select on societies for select
      using (app_is_super_admin() or id = app_current_society_id())
  `.execute(db);
  await sql`
    create policy societies_insert on societies for insert
      with check (app_is_super_admin())
  `.execute(db);
  await sql`
    create policy societies_update on societies for update
      using (app_is_super_admin() or id = app_current_society_id())
      with check (app_is_super_admin() or id = app_current_society_id())
  `.execute(db);
  await sql`
    create policy institutions_select on institutions for select
      using (app_is_super_admin() or society_id = app_current_society_id())
  `.execute(db);
  await sql`
    create policy institutions_insert on institutions for insert
      with check (app_is_super_admin() or society_id = app_current_society_id())
  `.execute(db);
  await sql`
    create policy institutions_update on institutions for update
      using (app_is_super_admin() or society_id = app_current_society_id())
      with check (app_is_super_admin() or society_id = app_current_society_id())
  `.execute(db);

  // Soft delete only: the foundation's default privileges grant DELETE, the
  // tenant roots take it back.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete on table societies, institutions from erp_app;
      end if;
    end;
    $$
  `.execute(db);

  // The keys that earlier migrations were waiting for.
  await sql`
    alter table role_assignments
      add constraint fk_role_assignments_society foreign key (society_id) references societies (id)
  `.execute(db);
  await sql`
    alter table role_assignments
      add constraint fk_role_assignments_institution
      foreign key (institution_id, society_id) references institutions (id, society_id)
  `.execute(db);
  await sql`
    alter table auth_sessions
      add constraint fk_auth_sessions_society foreign key (active_society_id) references societies (id)
  `.execute(db);
  // Roles 2 to 4 act inside a Society (roles 1 and 5 have none, DDD 9.1), so a
  // session without one would slip past the pause check.
  await sql`
    alter table auth_sessions
      add constraint ck_auth_sessions_society
      check (active_role_code is null or active_role_code in (1, 5) or active_society_id is not null)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the tenancy tables in production: they hold every school');
  }
  await sql`alter table auth_sessions drop constraint if exists ck_auth_sessions_society`.execute(
    db,
  );
  await sql`alter table auth_sessions drop constraint if exists fk_auth_sessions_society`.execute(
    db,
  );
  await sql`alter table role_assignments drop constraint if exists fk_role_assignments_institution`.execute(
    db,
  );
  await sql`alter table role_assignments drop constraint if exists fk_role_assignments_society`.execute(
    db,
  );
  await sql`drop table if exists institutions`.execute(db);
  await sql`drop table if exists societies`.execute(db);
  await sql`drop function if exists tenancy_guard_platform_columns()`.execute(db);
}
