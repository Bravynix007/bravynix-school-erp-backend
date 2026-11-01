import { sql, type Kysely } from 'kysely';

/**
 * Platform billing, part 1: the per-student rate of each Institution (DDD 9.10,
 * PRD 9.2). Each change is a new row with its effective date, so a due raised
 * earlier keeps the rate it was raised at. Rows are never edited or deleted: a
 * mistake is corrected by a newer row.
 *
 * Only Super Admin reads and writes them for now. The PRD lets a Society Owner
 * view pricing (PRD 3.2, DDD 9.10) and an Institution Admin not see it, but no
 * V1 endpoint shows an Owner a rate (BIL-01 carries amounts, not the rate), so
 * the read policy widens to the Society's Owners with the endpoint that needs it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table institution_price_rates (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid not null references users (id),
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid not null,
      rate_per_student_amount numeric(10, 2) not null,
      effective_from_date date not null,
      note varchar(500),
      constraint fk_institution_price_rates_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint ck_institution_price_rates_rate check (rate_per_student_amount >= 0),
      constraint ck_institution_price_rates_note check (note is null or btrim(note) <> ''),
      constraint uq_institution_price_rates_effective unique (institution_id, effective_from_date)
    )
  `.execute(db);

  await sql`alter table institution_price_rates enable row level security`.execute(db);
  await sql`alter table institution_price_rates force row level security`.execute(db);
  await sql`
    create policy institution_price_rates_select on institution_price_rates for select
      using (app_is_super_admin())
  `.execute(db);
  await sql`
    create policy institution_price_rates_insert on institution_price_rates for insert
      with check (app_is_super_admin())
  `.execute(db);
  // Insert-only: the foundation's default privileges grant more, take it back.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, delete, truncate on table institution_price_rates from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop institution_price_rates in production: it holds the rate history',
    );
  }
  await sql`drop table if exists institution_price_rates`.execute(db);
}
