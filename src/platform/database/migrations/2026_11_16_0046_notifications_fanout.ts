import { sql, type Kysely } from 'kysely';

/**
 * Notifications, part 2 (DDD 9.8, 14.5; plan B2b): what the worker needs to write a fan-out and to keep the
 * partitions, as `maintenance` functions the app role may only call (as with the job queue and the sweeps).
 *
 * - `maintenance.deliver_inbox_items(...)` writes one notice to each of its receivers and answers the receivers whose
 *   row it added, so a rerun of the job after a crash adds nothing twice and sends no second push. The rows take the
 *   source event's time as `created_at`, so `uq_inbox_items_source` finds the same row again. It must be a function
 *   because `INSERT ... ON CONFLICT` also reads the row it meets, and no worker may read a person's inbox: the owner
 *   role gets the two narrow policies the function needs (read and insert), as the sweeps do for their tables. The
 *   function refuses a Society that is not the caller's own (`app.society_id`), so the check the insert policy makes
 *   for the app role is kept.
 * - `maintenance.drop_inbox_partitions(p_keep_days)` drops the monthly partitions whose last day is more than
 *   `p_keep_days` days past (DDD 9.8: 180), whole, and answers how many.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [command, clause] of [
    ['select', 'using (true)'],
    ['insert', 'with check (true)'],
  ] as const) {
    await sql`
      do $$
      begin
        execute format(
          ${sql.lit(`create policy inbox_items_deliverer_${command} on public.inbox_items for ${command} to %I ${clause}`)},
          current_user
        );
      end;
      $$
    `.execute(db);
  }

  await sql`
    create function maintenance.deliver_inbox_items(
      p_society uuid, p_institution uuid, p_source_key text, p_occurred_at timestamptz,
      p_category smallint, p_tab smallint, p_title text, p_body text, p_sender text,
      p_target_type smallint, p_target_id uuid, p_receivers jsonb
    )
    returns table (receiver_id uuid)
    language plpgsql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
    begin
      if p_society is distinct from nullif(current_setting('app.society_id', true), '')::uuid then
        raise exception 'A fan-out may only be written for the Society of the job' using errcode = '42501';
      end if;
      return query
        insert into public.inbox_items
          (created_at, user_id, society_id, institution_id, student_id, category, inbox_tab, title, body,
           sender_display_name, source_key, target_type, target_id)
        select p_occurred_at, r."userId", p_society, p_institution, r."studentId", p_category, p_tab, p_title,
          p_body, p_sender, p_source_key, p_target_type, p_target_id
        from jsonb_to_recordset(p_receivers) as r ("userId" uuid, "studentId" uuid)
        on conflict (user_id, source_key, created_at) do nothing
        returning user_id;
    end;
    $$
  `.execute(db);

  await sql`
    create function maintenance.drop_inbox_partitions(p_keep_days integer)
    returns integer
    language plpgsql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
    declare
      part record;
      month_end date;
      dropped integer := 0;
    begin
      if p_keep_days < 30 then
        raise exception 'p_keep_days must be at least 30';
      end if;
      for part in
        select c.relname::text as name
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'public.inbox_items'::regclass
        order by c.relname
      loop
        if part.name ~ '^inbox_items_[0-9]{4}_[0-9]{2}$' then
          month_end := (to_date(substr(part.name, 13), 'YYYY_MM') + interval '1 month')::date;
          if month_end <= (now() - make_interval(days => p_keep_days))::date then
            execute format('drop table public.%I', part.name);
            dropped := dropped + 1;
          end if;
        end if;
      end loop;
      return dropped;
    end;
    $$
  `.execute(db);

  for (const signature of [
    'maintenance.deliver_inbox_items(uuid, uuid, text, timestamptz, smallint, smallint, text, text, text, smallint, uuid, jsonb)',
    'maintenance.drop_inbox_partitions(integer)',
  ]) {
    await sql`revoke all on function ${sql.raw(signature)} from public`.execute(db);
    await sql`
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'erp_app') then
          grant execute on function ${sql.raw(signature)} to erp_app;
        end if;
      end;
      $$
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the worker's fan-out relies on these.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the notification fan-out functions in production');
  }
  await sql`drop function if exists maintenance.drop_inbox_partitions(integer)`.execute(db);
  await sql`
    drop function if exists maintenance.deliver_inbox_items(
      uuid, uuid, text, timestamptz, smallint, smallint, text, text, text, smallint, uuid, jsonb)
  `.execute(db);
  await sql`drop policy if exists inbox_items_deliverer_insert on inbox_items`.execute(db);
  await sql`drop policy if exists inbox_items_deliverer_select on inbox_items`.execute(db);
}
