import { sql, type Kysely } from 'kysely';

/**
 * An Institution's place and its classes offered (DDD 9.3, PRD 7.1, decision 24).
 *
 * `institutions` gets `country_id`, `state_id` and `city_id`, which point at the platform masters and are all
 * optional. They form a chain (a city needs its state, a state its country); that the state belongs to the
 * country and the city to the state is checked by the service, which also refuses a hidden entry.
 *
 * `institution_class_categories` holds the class categories an Institution offers; it may create classes only
 * from these. A row is deleted when the category is unticked, so the app role keeps its DELETE right here, and
 * the key from `classes` (a later slice) is what refuses to untick a category a class uses. Institution-level
 * row-level security (DDD 15.3): the caller's Society and one of the Institutions in scope.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table institutions
      add column country_id uuid references countries (id) on delete restrict,
      add column state_id uuid references states (id) on delete restrict,
      add column city_id uuid references cities (id) on delete restrict,
      add constraint ck_institutions_place_chain check (
        (state_id is null or country_id is not null) and (city_id is null or state_id is not null)
      )
  `.execute(db);

  await sql`
    create table institution_class_categories (
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid not null,
      class_category_id uuid not null references class_categories (id) on delete restrict,
      primary key (institution_id, class_category_id),
      constraint fk_institution_class_categories_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict
    )
  `.execute(db);

  await sql`alter table institution_class_categories enable row level security`.execute(db);
  await sql`alter table institution_class_categories force row level security`.execute(db);
  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  await sql`create policy institution_class_categories_select on institution_class_categories for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy institution_class_categories_insert on institution_class_categories for insert with check (${inScope})`.execute(
    db,
  );
  await sql`create policy institution_class_categories_delete on institution_class_categories for delete using (${inScope})`.execute(
    db,
  );
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, truncate on table institution_class_categories from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): classes refer to the categories an Institution offers.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the Institution places and classes offered in production');
  }
  await sql`drop table if exists institution_class_categories`.execute(db);
  await sql`
    alter table institutions
      drop constraint if exists ck_institutions_place_chain,
      drop column if exists city_id,
      drop column if exists state_id,
      drop column if exists country_id
  `.execute(db);
}
