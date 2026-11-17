import { sql, type Kysely } from 'kysely';

/**
 * Attendance, part 2 (DDD 13.1; API design 10.12): correcting a submitted session.
 *
 * A correction changes a student's mark (UPDATE), takes a student back to Present by removing the exception (DELETE),
 * or makes a Present student Absent, Late, Half day or Leave by adding one (INSERT, already allowed). The exceptions
 * policies read the Institution alone, as their SELECT and INSERT do. The DELETE right is given on the parent table
 * only: the partitions stay out of the app role's reach. TRUNCATE stays withheld.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create policy attendance_exceptions_update on attendance_exceptions for update
      using (institution_id = any (app_current_institution_ids()))
      with check (institution_id = any (app_current_institution_ids()))
  `.execute(db);
  await sql`
    create policy attendance_exceptions_delete on attendance_exceptions for delete
      using (institution_id = any (app_current_institution_ids()))
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant delete on table public.attendance_exceptions to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop attendance corrections in production');
  }
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete on table public.attendance_exceptions from erp_app;
      end if;
    end;
    $$
  `.execute(db);
  await sql`drop policy if exists attendance_exceptions_delete on attendance_exceptions`.execute(
    db,
  );
  await sql`drop policy if exists attendance_exceptions_update on attendance_exceptions`.execute(
    db,
  );
}
