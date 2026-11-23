import { sql, type Kysely } from 'kysely';

const OLD_SIGNATURE =
  'maintenance.deliver_inbox_items(uuid, uuid, text, timestamptz, smallint, smallint, text, text, text, smallint, uuid, jsonb)';
const NEW_SIGNATURE =
  'maintenance.deliver_inbox_items(uuid, uuid, text, timestamptz, smallint, smallint, text, text, text, smallint, uuid, date, jsonb)';

/**
 * The day a notice is about (API design 10.4h, 10.14a): `inbox_items.target_date`. A parent who taps "New diary entry"
 * lands on the diary of that day, which the notice's own time cannot give (an entry may be dated up to seven days back,
 * and one written in the evening is read the next morning). It means something only with a target, so it is null
 * without one; the other targets leave it null. The fan-out function takes it with the target.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table inbox_items add column target_date date`.execute(db);
  await sql`
    alter table inbox_items add constraint ck_inbox_items_target_date
      check (target_date is null or target_id is not null)
  `.execute(db);

  await sql`drop function maintenance.deliver_inbox_items(
      uuid, uuid, text, timestamptz, smallint, smallint, text, text, text, smallint, uuid, jsonb)`.execute(
    db,
  );
  await sql`
    create function maintenance.deliver_inbox_items(
      p_society uuid, p_institution uuid, p_source_key text, p_occurred_at timestamptz,
      p_category smallint, p_tab smallint, p_title text, p_body text, p_sender text,
      p_target_type smallint, p_target_id uuid, p_target_date date, p_receivers jsonb
    )
    returns table (receiver_id uuid)
    language plpgsql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
    begin
      if p_society is null or p_society is distinct from nullif(current_setting('app.society_id', true), '')::uuid then
        raise exception 'A fan-out may only be written for the Society of the job' using errcode = '42501';
      end if;
      return query
        insert into public.inbox_items
          (created_at, user_id, society_id, institution_id, student_id, category, inbox_tab, title, body,
           sender_display_name, source_key, target_type, target_id, target_date)
        select p_occurred_at, r."userId", p_society, p_institution, r."studentId", p_category, p_tab, p_title,
          p_body, p_sender, p_source_key, p_target_type, p_target_id, p_target_date
        from jsonb_to_recordset(p_receivers) as r ("userId" uuid, "studentId" uuid)
        -- A receiver who is no person (removed since the notice was asked for) is passed over, so one bad ID never
        -- fails the batch and keeps the notice from the rest.
        join public.users u on u.id = r."userId"
        on conflict (user_id, source_key, created_at) do nothing
        returning user_id;
    end;
    $$
  `.execute(db);
  await sql`revoke all on function ${sql.raw(NEW_SIGNATURE)} from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function ${sql.raw(NEW_SIGNATURE)} to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the worker's fan-out relies on this function.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the notice target date in production');
  }
  await sql`drop function maintenance.deliver_inbox_items(
      uuid, uuid, text, timestamptz, smallint, smallint, text, text, text, smallint, uuid, date, jsonb)`.execute(
    db,
  );
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
      if p_society is null or p_society is distinct from nullif(current_setting('app.society_id', true), '')::uuid then
        raise exception 'A fan-out may only be written for the Society of the job' using errcode = '42501';
      end if;
      return query
        insert into public.inbox_items
          (created_at, user_id, society_id, institution_id, student_id, category, inbox_tab, title, body,
           sender_display_name, source_key, target_type, target_id)
        select p_occurred_at, r."userId", p_society, p_institution, r."studentId", p_category, p_tab, p_title,
          p_body, p_sender, p_source_key, p_target_type, p_target_id
        from jsonb_to_recordset(p_receivers) as r ("userId" uuid, "studentId" uuid)
        join public.users u on u.id = r."userId"
        on conflict (user_id, source_key, created_at) do nothing
        returning user_id;
    end;
    $$
  `.execute(db);
  await sql`revoke all on function ${sql.raw(OLD_SIGNATURE)} from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function ${sql.raw(OLD_SIGNATURE)} to erp_app;
      end if;
    end;
    $$
  `.execute(db);
  await sql`alter table inbox_items drop constraint ck_inbox_items_target_date`.execute(db);
  await sql`alter table inbox_items drop column target_date`.execute(db);
}
