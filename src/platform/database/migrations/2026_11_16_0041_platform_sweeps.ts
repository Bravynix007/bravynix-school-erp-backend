import { sql, type Kysely } from 'kysely';

/**
 * The worker's clean-up sweeps (DDD 16.3 and 16.4, plan change 8): four `maintenance` functions the worker calls
 * across every Society, because no one Society's rows are the clean-up's to see.
 *
 * - `expire_files(p_document_days, p_grace_hours)` gives a Ready file its `delete_after` (now) when it should go: a
 *   document file `p_document_days` after DOC-03 deactivated the document (the document row stays), and a file
 *   that nothing points at any more (the column its purpose names, DDD 16.2), once it has been Ready for
 *   `p_grace_hours` so a file that was just confirmed and not yet attached is left alone. Pending and import files
 *   already carry their `delete_after` from the request and the confirmation. It answers how many it gave.
 * - `expired_files(p_limit)` lists the files that are due: Pending, Ready or Rejected, with `delete_after` past. The
 *   worker removes each object, then settles the row.
 * - `settle_file_deleted(p_id, p_status)` marks one file Deleted, only while it is still in the status the worker
 *   listed it in, so a file that was confirmed in the meantime is not marked.
 * - `remove_import_runs(p_days)` deletes the import runs that finished `p_days` ago (API design 16.3).
 *
 * Each runs as the table owner, whom forced row-level security binds, so the owner role gets the narrowest policies
 * these functions need: read the owners of files and read and update `files`, and read and delete `import_runs`. The
 * app role gets none of them and may only call the functions, as with the job queue.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // The policies name the role that owns the tables, which the forced policies would bind too.
  for (const [table, command] of [
    ['files', 'select'],
    ['files', 'update'],
    ['documents', 'select'],
    ['students', 'select'],
    ['staff_members', 'select'],
    ['import_runs', 'select'],
    ['import_runs', 'delete'],
  ] as const) {
    const using = command === 'update' ? 'using (true) with check (true)' : 'using (true)';
    await sql`
      do $$
      begin
        execute format(
          ${sql.lit(`create policy ${table}_sweeper_${command} on public.${table} for ${command} to %I ${using}`)},
          current_user
        );
      end;
      $$
    `.execute(db);
  }

  await sql`
    create function maintenance.expire_files(p_document_days integer, p_grace_hours integer)
    returns integer
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      with given as (
        update public.files f
           set delete_after = now()
         where f.file_status = 2
           and f.delete_after is null
           and (
             (f.purpose in (5, 6) and exists (
               select 1 from public.documents d
                where d.file_id = f.id and d.status = 0
                  and d.updated_at <= now() - make_interval(days => p_document_days)
             ))
             or (f.confirmed_at <= now() - make_interval(hours => p_grace_hours) and (
               (f.purpose = 3 and not exists (
                 select 1 from public.students s where s.photo_file_id = f.id))
               or (f.purpose = 4 and not exists (
                 select 1 from public.staff_members m where m.photo_file_id = f.id))
               or (f.purpose in (5, 6) and not exists (
                 select 1 from public.documents d where d.file_id = f.id))
               or (f.purpose = 12 and not exists (
                 select 1 from public.import_runs r where r.file_id = f.id))
             ))
           )
        returning 1
      )
      select count(*)::integer from given
    $$
  `.execute(db);
  await sql`
    create function maintenance.expired_files(p_limit integer)
    returns table (id uuid, object_key varchar, file_status smallint)
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      select f.id, f.object_key, f.file_status
        from public.files f
       where f.file_status in (1, 2, 3) and f.delete_after <= now()
       order by f.delete_after, f.id
       limit p_limit
    $$
  `.execute(db);
  await sql`
    create function maintenance.settle_file_deleted(p_id uuid, p_status smallint) returns boolean
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      with settled as (
        update public.files
           set file_status = 4, deleted_at = coalesce(deleted_at, now())
         where id = p_id and file_status = p_status and delete_after <= now()
        returning 1
      )
      select exists (select 1 from settled)
    $$
  `.execute(db);
  await sql`
    create function maintenance.remove_import_runs(p_days integer) returns integer
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      with removed as (
        delete from public.import_runs
         where run_status in (3, 4) and finished_at <= now() - make_interval(days => p_days)
        returning 1
      )
      select count(*)::integer from removed
    $$
  `.execute(db);

  for (const signature of [
    'expire_files(integer, integer)',
    'expired_files(integer)',
    'settle_file_deleted(uuid, smallint)',
    'remove_import_runs(integer)',
  ]) {
    await sql`revoke all on function ${sql.raw(`maintenance.${signature}`)} from public`.execute(
      db,
    );
  }
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant usage on schema maintenance to erp_app;
        grant execute on function maintenance.expire_files(integer, integer) to erp_app;
        grant execute on function maintenance.expired_files(integer) to erp_app;
        grant execute on function maintenance.settle_file_deleted(uuid, smallint) to erp_app;
        grant execute on function maintenance.remove_import_runs(integer) to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the sweep functions in production');
  }
  await sql`drop function if exists maintenance.remove_import_runs(integer)`.execute(db);
  await sql`drop function if exists maintenance.settle_file_deleted(uuid, smallint)`.execute(db);
  await sql`drop function if exists maintenance.expired_files(integer)`.execute(db);
  await sql`drop function if exists maintenance.expire_files(integer, integer)`.execute(db);
  for (const [table, command] of [
    ['files', 'select'],
    ['files', 'update'],
    ['documents', 'select'],
    ['students', 'select'],
    ['staff_members', 'select'],
    ['import_runs', 'select'],
    ['import_runs', 'delete'],
  ] as const) {
    await sql`drop policy if exists ${sql.id(`${table}_sweeper_${command}`)} on ${sql.table(table)}`.execute(
      db,
    );
  }
}
