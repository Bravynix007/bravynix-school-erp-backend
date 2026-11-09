import { sql, type Kysely } from 'kysely';

/**
 * People, part 2 (DDD 9.5, PRD 4 and 7.5): what a staff member may do in the Society.
 *
 * - `staff_members.access_blocked_at` and `access_blocked_by`: a block from the teacher's profile (STF-06, DDD D-02). It
 *   stops the staff role in this Society only; both columns are set or both are empty.
 * - `staff_institutions`: the extra Institutions a Society Owner lets a staff member see (STF-10). The home
 *   Institution stays on `staff_members`, so the two cannot disagree. A row is deleted when the list changes (the audit
 *   entry keeps before and after).
 * - `staff_subjects`: the subjects a staff member can teach (STF-08), which the timetable and the teaching
 *   assignments check. Deleted the same way.
 *
 * Both lists use the Society-level policy, like the staff tables of migration 0024.
 *
 * Two definer functions let sign-in and every request ask about a person without a tenant narrowed to them, the way
 * `app_active_blocks` and `app_staff_roles` do: they act as Super Admin for the read, put the caller's settings back
 * before they return, have a fixed search_path, and only the app role may call them.
 *
 * - `app_staff_blocked(society, person)`: does the person hold an active staff record in the Society that is blocked?
 * - `app_staff_extra_institutions(society, person)`: the extra Institutions of the person's active staff record there.
 *
 * `app_staff_roles` (migration 0025) is replaced so a teacher's staff section counts as blocked only when every
 * Institution they reach, the home one and the active extras, has it blocked (API design 6.3).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table staff_members
      add column access_blocked_at timestamptz,
      add column access_blocked_by uuid references users (id),
      add constraint ck_staff_members_access_block
        check ((access_blocked_at is null) = (access_blocked_by is null))
  `.execute(db);

  await sql`
    create table staff_institutions (
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      society_id uuid not null,
      staff_member_id uuid not null,
      institution_id uuid not null,
      primary key (staff_member_id, institution_id),
      constraint fk_staff_institutions_staff foreign key (staff_member_id, society_id)
        references staff_members (id, society_id) on delete restrict,
      constraint fk_staff_institutions_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict
    )
  `.execute(db);
  await sql`
    create index ix_staff_institutions_institution on staff_institutions (institution_id)
  `.execute(db);

  await sql`
    create table staff_subjects (
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      society_id uuid not null,
      staff_member_id uuid not null,
      subject_id uuid not null,
      primary key (staff_member_id, subject_id),
      constraint fk_staff_subjects_staff foreign key (staff_member_id, society_id)
        references staff_members (id, society_id) on delete restrict,
      constraint fk_staff_subjects_subject foreign key (subject_id, society_id)
        references subjects (id, society_id) on delete restrict
    )
  `.execute(db);
  await sql`create index ix_staff_subjects_subject on staff_subjects (subject_id)`.execute(db);

  for (const table of ['staff_institutions', 'staff_subjects']) {
    const t = sql.table(table);
    const policy = (suffix: string) => sql.id(`${table}_${suffix}`);
    await sql`alter table ${t} enable row level security`.execute(db);
    await sql`alter table ${t} force row level security`.execute(db);
    await sql`create policy ${policy('select')} on ${t} for select using (society_id = app_current_society_id())`.execute(
      db,
    );
    await sql`create policy ${policy('insert')} on ${t} for insert with check (society_id = app_current_society_id())`.execute(
      db,
    );
    await sql`create policy ${policy('delete')} on ${t} for delete using (society_id = app_current_society_id())`.execute(
      db,
    );
  }
  // The lists are only ever replaced whole: rows are inserted and deleted, never updated.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, truncate on table staff_institutions, staff_subjects from erp_app;
      end if;
    end;
    $$
  `.execute(db);

  await sql`
    create function app_staff_blocked(society uuid, person uuid) returns boolean
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_society text := current_setting('app.society_id', true);
      found boolean;
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.society_id', society::text, true);
      select exists (
        select 1 from staff_members m
        where m.user_id = person and m.society_id = society and m.status = 1
          and m.access_blocked_at is not null
      ) into found;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.society_id', coalesce(caller_society, ''), true);
      return found;
    end;
    $$
  `.execute(db);
  await sql`
    create function app_staff_extra_institutions(society uuid, person uuid) returns setof uuid
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_society text := current_setting('app.society_id', true);
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.society_id', society::text, true);
      return query
        select i.institution_id from staff_institutions i
        join staff_members m on m.id = i.staff_member_id
        where m.user_id = person and m.society_id = society and m.status = 1;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.society_id', coalesce(caller_society, ''), true);
    end;
    $$
  `.execute(db);
  for (const signature of [
    'app_staff_blocked(uuid, uuid)',
    'app_staff_extra_institutions(uuid, uuid)',
  ]) {
    const fn = sql.raw(signature);
    await sql`revoke all on function ${fn} from public`.execute(db);
    await sql`
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'erp_app') then
          grant execute on function ${fn} to erp_app;
        end if;
      end;
      $$
    `.execute(db);
  }
  // A teacher's staff section is blocked only when every Institution they reach is: the home one and the active
  // extras (API design 6.3). The extras come through their own definer function, because this one has no Society set.
  await sql`
    create or replace function app_staff_roles(person uuid)
      returns table (society_id uuid, home_institution_id uuid, society_name text, staff_blocked boolean)
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_person text := current_setting('app.person_id', true);
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.person_id', person::text, true);
      return query
        select m.society_id, m.home_institution_id, s.name::text,
          not exists (
            select 1 from (
              select m.home_institution_id as institution_id
              union
              select x.id from app_staff_extra_institutions(m.society_id, person) as x(id)
                join institutions xi on xi.id = x.id and xi.status = 1
            ) reached
            where not exists (
              select 1 from access_blocks b
              where b.society_id = m.society_id and b.institution_id = reached.institution_id
                and b.section = 2 and b.lifted_at is null
            )
          )
        from staff_members m
        join societies s on s.id = m.society_id and s.status = 1
        join institutions i on i.id = m.home_institution_id and i.status = 1
        where m.user_id = person and m.status = 1
        order by m.created_at, m.id;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.person_id', coalesce(caller_person, ''), true);
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): blocks and subject lists are records of what was decided.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop staff access in production: blocks and lists are records');
  }
  await sql`
    create or replace function app_staff_roles(person uuid)
      returns table (society_id uuid, home_institution_id uuid, society_name text, staff_blocked boolean)
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_person text := current_setting('app.person_id', true);
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.person_id', person::text, true);
      return query
        select m.society_id, m.home_institution_id, s.name::text,
          exists (
            select 1 from access_blocks b
            where b.society_id = m.society_id and b.institution_id = m.home_institution_id
              and b.section = 2 and b.lifted_at is null
          )
        from staff_members m
        join societies s on s.id = m.society_id and s.status = 1
        join institutions i on i.id = m.home_institution_id and i.status = 1
        where m.user_id = person and m.status = 1
        order by m.created_at, m.id;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.person_id', coalesce(caller_person, ''), true);
    end;
    $$
  `.execute(db);
  await sql`drop function if exists app_staff_extra_institutions(uuid, uuid)`.execute(db);
  await sql`drop function if exists app_staff_blocked(uuid, uuid)`.execute(db);
  await sql`drop table if exists staff_subjects`.execute(db);
  await sql`drop table if exists staff_institutions`.execute(db);
  await sql`
    alter table staff_members
      drop constraint if exists ck_staff_members_access_block,
      drop column if exists access_blocked_by,
      drop column if exists access_blocked_at
  `.execute(db);
}
