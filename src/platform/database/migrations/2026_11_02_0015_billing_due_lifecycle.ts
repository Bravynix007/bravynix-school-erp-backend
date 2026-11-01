import { sql, type Kysely } from 'kysely';

/**
 * Platform billing, part 3: a due can now be edited while it is Due, marked
 * paid, or cancelled (PRD 9.3, API design 10.22).
 *
 * - The app role may change only the columns those three actions change, and
 *   only Super Admin may update a row. The invoice number, the Society, the
 *   Institution, the automatic student count and the author stay as raised.
 * - A Paid or Cancelled due is final: a trigger refuses any change to it, so
 *   "Paid cannot be undone" holds even for a statement that skips the service.
 * - The rate a due copied must match its rate row exactly (amount included), so
 *   "the rate is frozen" is a database rule and not only a habit of the service.
 */
const CHANGEABLE_COLUMNS = [
  // Edit
  'period_start_date',
  'period_end_date',
  'student_count',
  'student_count_note',
  'price_rate_id',
  'rate_per_student_amount',
  'base_amount',
  'adjustment_amount',
  'adjustment_note',
  'total_amount',
  'due_date',
  // Mark paid
  'due_status',
  'paid_date',
  'payment_mode',
  'payment_reference',
  // Cancel
  'cancelled_at',
  'cancelled_by',
  'cancel_reason',
  // Every change
  'updated_by',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table institution_price_rates
      add constraint uq_institution_price_rates_id_institution_rate
      unique (id, institution_id, rate_per_student_amount)
  `.execute(db);
  await sql`alter table platform_dues drop constraint fk_platform_dues_rate`.execute(db);
  await sql`
    alter table platform_dues
      add constraint fk_platform_dues_rate
      foreign key (price_rate_id, institution_id, rate_per_student_amount)
      references institution_price_rates (id, institution_id, rate_per_student_amount)
      on delete restrict
  `.execute(db);

  await sql`
    create policy platform_dues_update on platform_dues for update
      using (app_is_super_admin())
      with check (app_is_super_admin())
  `.execute(db);
  await sql
    .raw(
      `
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant update (${CHANGEABLE_COLUMNS.join(', ')}) on table platform_dues to erp_app;
      end if;
    end;
    $$
  `,
    )
    .execute(db);

  await sql`
    create function platform_dues_refuse_final_change() returns trigger
    language plpgsql as $$
    begin
      if old.due_status <> 1 then
        raise exception 'A % due cannot be changed',
          case old.due_status when 2 then 'Paid' else 'Cancelled' end
          using errcode = 'check_violation', constraint = 'ck_platform_dues_final';
      end if;
      return new;
    end;
    $$
  `.execute(db);
  await sql`
    create trigger trg_platform_dues_final before update on platform_dues
      for each row execute function platform_dues_refuse_final_change()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the platform_dues lifecycle rules in production');
  }
  await sql`drop trigger if exists trg_platform_dues_final on platform_dues`.execute(db);
  await sql`drop function if exists platform_dues_refuse_final_change()`.execute(db);
  await sql`drop policy if exists platform_dues_update on platform_dues`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update on table platform_dues from erp_app;
      end if;
    end;
    $$
  `.execute(db);
  await sql`alter table platform_dues drop constraint if exists fk_platform_dues_rate`.execute(db);
  await sql`
    alter table platform_dues
      add constraint fk_platform_dues_rate foreign key (price_rate_id, institution_id)
      references institution_price_rates (id, institution_id) on delete restrict
  `.execute(db);
  await sql`
    alter table institution_price_rates
      drop constraint if exists uq_institution_price_rates_id_institution_rate
  `.execute(db);
}
