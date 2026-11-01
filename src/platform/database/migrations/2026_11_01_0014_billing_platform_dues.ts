import { sql, type Kysely } from 'kysely';

/**
 * Platform billing, part 2: the dues Super Admin raises against an Institution
 * (DDD 9.10, PRD 9.3). A due covers a period of any length. The student count,
 * the rate and every amount are frozen when it is raised, so a later rate change
 * never alters it (PRD 9.2). Rows are never deleted: cancelling keeps the row.
 *
 * Only Super Admin reads and writes them for now. The Society Owner's own view
 * (BIL-01, BIL-02) widens the read policy with the endpoints that need it. The
 * app role may insert and read but not edit yet: the edit, mark-paid and cancel
 * slice grants the exact columns those operations change.
 *
 * Not here yet: `invoice_file_id`. It points at the Files module (Phase 4) and
 * arrives with it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // The due names the exact rate row it used, and that row must be the Institution's own.
  await sql`
    alter table institution_price_rates
      add constraint uq_institution_price_rates_id_institution unique (id, institution_id)
  `.execute(db);

  await sql`
    create table platform_dues (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid not null references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid not null,
      invoice_no varchar(30) not null,
      period_start_date date not null,
      period_end_date date not null,
      student_count_auto integer not null,
      student_count integer not null,
      student_count_note varchar(500),
      price_rate_id uuid not null,
      rate_per_student_amount numeric(10, 2) not null,
      base_amount numeric(12, 2) not null,
      adjustment_amount numeric(12, 2) not null default 0,
      adjustment_note varchar(500),
      total_amount numeric(12, 2) not null,
      due_date date,
      due_status smallint not null default 1,
      paid_date date,
      payment_mode smallint,
      payment_reference varchar(100),
      cancelled_at timestamptz,
      cancelled_by uuid references users (id),
      cancel_reason varchar(500),
      constraint fk_platform_dues_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_platform_dues_rate foreign key (price_rate_id, institution_id)
        references institution_price_rates (id, institution_id) on delete restrict,
      constraint uq_platform_dues_invoice_no unique (invoice_no),
      constraint ck_platform_dues_period check (period_end_date >= period_start_date),
      constraint ck_platform_dues_counts check (student_count >= 0 and student_count_auto >= 0),
      constraint ck_platform_dues_count_note check (
        (student_count = student_count_auto or coalesce(btrim(student_count_note) <> '', false))
        and (student_count_note is null or btrim(student_count_note) <> '')
      ),
      constraint ck_platform_dues_base check (
        base_amount = student_count * rate_per_student_amount and rate_per_student_amount >= 0
      ),
      constraint ck_platform_dues_adjustment_note check (
        (adjustment_amount = 0 or coalesce(btrim(adjustment_note) <> '', false))
        and (adjustment_note is null or btrim(adjustment_note) <> '')
      ),
      constraint ck_platform_dues_total check (
        total_amount = base_amount + adjustment_amount and total_amount >= 0
      ),
      constraint ck_platform_dues_status check (due_status in (0, 1, 2)),
      constraint ck_platform_dues_mode check (payment_mode is null or payment_mode in (1, 2, 3, 4)),
      constraint ck_platform_dues_paid check (
        (due_status = 2) = (paid_date is not null and payment_mode is not null)
        and (due_status = 2 or payment_reference is null)
      ),
      constraint ck_platform_dues_cancelled check (
        (due_status = 0) = (cancelled_at is not null)
        and (cancelled_at is null) = (cancelled_by is null)
        and (cancelled_at is null) = (cancel_reason is null)
        and (cancel_reason is null or btrim(cancel_reason) <> '')
      )
    )
  `.execute(db);
  // "You are due ₹X" (the sum of Due rows) and the Owner's list.
  await sql`create index ix_platform_dues_society_status on platform_dues (society_id, due_status)`.execute(
    db,
  );
  // The Institution's dues tab, newest period first.
  await sql`
    create index ix_platform_dues_institution_period
      on platform_dues (institution_id, period_start_date desc)
  `.execute(db);
  await sql`
    create trigger trg_platform_dues_updated before update on platform_dues
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_platform_dues_version before update on platform_dues
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table platform_dues enable row level security`.execute(db);
  await sql`alter table platform_dues force row level security`.execute(db);
  await sql`
    create policy platform_dues_select on platform_dues for select
      using (app_is_super_admin())
  `.execute(db);
  await sql`
    create policy platform_dues_insert on platform_dues for insert
      with check (app_is_super_admin())
  `.execute(db);
  // The foundation's default privileges grant more than a due may have.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, delete, truncate on table platform_dues from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop platform_dues in production: it holds invoices');
  }
  await sql`drop table if exists platform_dues`.execute(db);
  await sql`
    alter table institution_price_rates
      drop constraint if exists uq_institution_price_rates_id_institution
  `.execute(db);
}
