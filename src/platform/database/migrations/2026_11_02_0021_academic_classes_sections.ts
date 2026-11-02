import { sql, type Kysely } from 'kysely';

/**
 * Classes and sections (DDD 9.4, PRD 7.3). A class is an instance of a predefined class of the platform masters,
 * with an optional stream and a name the Institution may change; a section belongs to a class and is an instance
 * of a predefined section.
 *
 * `fk_classes_offered_category` is what keeps decision 24: a class can exist only in a category the Institution
 * offers, and a category cannot be unticked while a class (active or deactivated) is in it. The key
 * `(predefined_class_id, class_category_id)` keeps the copied category true. The uniqueness rules hold among
 * active rows only, so a deactivated class or section frees its name.
 *
 * Institution-level row-level security (DDD 15.3). Soft delete only: the app role has no DELETE right.
 * `uq_classes_id_institution`, `uq_sections_id_institution` and `uq_sections_id_class` are the targets of the keys
 * that later tables use (students, fee structures, timetables).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const standard = sql`
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid not null
  `;
  await sql`
    create table classes (
      ${standard},
      predefined_class_id uuid not null,
      class_category_id uuid not null,
      stream_name varchar(30),
      display_name varchar(60) not null,
      code varchar(50),
      constraint fk_classes_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_classes_predefined foreign key (predefined_class_id, class_category_id)
        references predefined_classes (id, class_category_id) on delete restrict,
      constraint fk_classes_offered_category foreign key (institution_id, class_category_id)
        references institution_class_categories (institution_id, class_category_id) on delete restrict,
      constraint uq_classes_id_institution unique (id, institution_id),
      constraint ck_classes_status check (status in (0, 1)),
      constraint ck_classes_display_name check (btrim(display_name) <> ''),
      constraint ck_classes_stream check (stream_name is null or btrim(stream_name) <> ''),
      constraint ck_classes_code check (code is null or btrim(code) <> '')
    )
  `.execute(db);
  await sql`
    create unique index uq_classes_institution_class_stream
      on classes (institution_id, predefined_class_id, lower(stream_name)) nulls not distinct
      where status = 1
  `.execute(db);
  await sql`
    create unique index uq_classes_institution_name
      on classes (institution_id, lower(display_name)) where status = 1
  `.execute(db);

  await sql`
    create table sections (
      ${standard},
      class_id uuid not null,
      predefined_section_id uuid not null references predefined_sections (id) on delete restrict,
      display_name varchar(30) not null,
      capacity smallint,
      constraint fk_sections_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_sections_class foreign key (class_id, institution_id)
        references classes (id, institution_id) on delete restrict,
      constraint uq_sections_id_institution unique (id, institution_id),
      constraint uq_sections_id_class unique (id, class_id),
      constraint ck_sections_status check (status in (0, 1)),
      constraint ck_sections_display_name check (btrim(display_name) <> ''),
      constraint ck_sections_capacity check (capacity is null or capacity > 0)
    )
  `.execute(db);
  await sql`
    create unique index uq_sections_class_predefined
      on sections (class_id, predefined_section_id) where status = 1
  `.execute(db);
  await sql`
    create unique index uq_sections_class_name
      on sections (class_id, lower(display_name)) where status = 1
  `.execute(db);

  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  for (const table of ['classes', 'sections']) {
    const name = sql.raw(table);
    await sql`
      create trigger ${sql.raw(`trg_${table}_updated`)} before update on ${name}
        for each row execute function set_updated_at()
    `.execute(db);
    await sql`
      create trigger ${sql.raw(`trg_${table}_version`)} before update on ${name}
        for each row execute function bump_version()
    `.execute(db);
    await sql`alter table ${name} enable row level security`.execute(db);
    await sql`alter table ${name} force row level security`.execute(db);
    await sql`create policy ${sql.raw(`${table}_select`)} on ${name} for select using (${inScope})`.execute(
      db,
    );
    await sql`create policy ${sql.raw(`${table}_insert`)} on ${name} for insert with check (${inScope})`.execute(
      db,
    );
    await sql`
      create policy ${sql.raw(`${table}_update`)} on ${name} for update
        using (${inScope}) with check (${inScope})
    `.execute(db);
  }
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table classes, sections from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): students, fees and timetables refer to classes and sections.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop classes and sections in production: later tables refer to them',
    );
  }
  await sql`drop table if exists sections`.execute(db);
  await sql`drop table if exists classes`.execute(db);
}
