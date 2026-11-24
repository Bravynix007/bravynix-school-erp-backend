import { sql, type Kysely } from 'kysely';

/**
 * An event's own picture (API design 10.26, DDD 9.8, 16.1): `events.image_file_id` points at a Ready file of purpose 10
 * (Event image). An event has a picture the app ships (`preset_image_code`) or one its organiser uploaded, never both.
 *
 * - The file is public (DDD 16.1): everyone the event is shown to opens its address, so `files_select_public` lets a
 *   request of the Society read the row of any public file, and a parent (who has no Society in the request, only a
 *   child) the row of a public file that an event they can read points at, the way a parent already reads their own
 *   child's photo. The object is public anyway; the row only gives the address and shows no key to a client. The
 *   subquery reads `events` under its own policies, and none of them reads `files`, so there is no recursion.
 * - A picture that no event points at any more (replaced, or removed) is given up by the sweep like a student's photo:
 *   `maintenance.expire_files` takes purpose 10 once it has been Ready for the grace period (DDD 16.4). The sweep reads
 *   `events` as the table owner, which the forced policies bind, so the owner role gets a read policy as for the others.
 */
const EXPIRE_FILES = (withEventImages: boolean) => sql`
  create or replace function maintenance.expire_files(p_document_days integer, p_grace_hours integer)
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
             ${sql.raw(
               withEventImages
                 ? `or (f.purpose = 10 and not exists (
               select 1 from public.events e where e.image_file_id = f.id))`
                 : '',
             )}
           ))
         )
      returning 1
    )
    select count(*)::integer from given
  $$
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events add column image_file_id uuid`.execute(db);
  await sql`
    alter table events
      add constraint fk_events_image_file foreign key (image_file_id, society_id)
        references files (id, society_id) on delete restrict,
      add constraint ck_events_image check (image_file_id is null or preset_image_code is null)
  `.execute(db);
  await sql`create index ix_events_image_file on events (image_file_id) where image_file_id is not null`.execute(
    db,
  );
  await sql`
    create policy files_select_public on files for select
      using (
        storage_bucket = 2
        and (
          society_id = app_current_society_id()
          or (
            app_current_role_code() = 5
            and exists (select 1 from events e where e.image_file_id = files.id)
          )
        )
      )
  `.execute(db);
  await sql`
    do $$
    begin
      execute format('create policy events_sweeper_select on public.events for select to %I using (true)', current_user);
    end;
    $$
  `.execute(db);
  await EXPIRE_FILES(true).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): events point at their pictures.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the event image in production: events refer to it');
  }
  await EXPIRE_FILES(false).execute(db);
  await sql`drop policy if exists events_sweeper_select on events`.execute(db);
  await sql`drop policy if exists files_select_public on files`.execute(db);
  await sql`drop index if exists ix_events_image_file`.execute(db);
  await sql`alter table events drop constraint ck_events_image`.execute(db);
  await sql`alter table events drop constraint fk_events_image_file`.execute(db);
  await sql`alter table events drop column image_file_id`.execute(db);
}
