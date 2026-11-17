import { sql, type Kysely } from 'kysely';

/**
 * People, part 11 (API design 6.3, 6.4 and 5.4): the Student / Parent context, role 5.
 *
 * - `app_children(person)`: the children a person guards, one row each, across every Society and Institution, with
 *   the facts a context list and the child switcher need (name, photo, Institution, current class and section, and
 *   whether the child or the child's Institution has its students blocked). A guardian's own link row is readable
 *   with their person ID alone (migration 0031), and each child is then read under that child's Society and
 *   Institution, as the other definer functions do, so the caller's settings are put back afterwards and no table
 *   policy is widened for the sign-in read. A child deactivated, or in a paused Society or Institution, is left out.
 *   A blocked child is kept, so the request can answer that the child is blocked and not that it does not exist.
 * - `app_current_child_ids()`: the children one request may read, set per transaction as `app.child_ids` by the
 *   `ChildAccess` service after it has checked the link, the way `app.institution_ids` is set for staff. A parent's
 *   rows are read with `id = any (app_current_child_ids())`, never with a subquery on the link table, so no policy
 *   reads the table it guards (which would recurse). The setting is only ever one verified child at a time.
 * - Read policies on the child's own rows for role 5: the student, the guardians, the enrolments, the section
 *   placements and the achievements. They are permissive and read only; a parent writes none of them. A parent
 *   in a request without `app.child_ids` (or with another role) matches none.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function app_current_child_ids() returns uuid[]
    language sql stable as $$
      select case
        when app_current_role_code() = 5 then coalesce(
          string_to_array(nullif(current_setting('app.child_ids', true), ''), ',')::uuid[],
          '{}'::uuid[]
        )
        else '{}'::uuid[]
      end
    $$
  `.execute(db);

  await sql`
    create function app_children(person uuid)
      returns table (
        student_id uuid, society_id uuid, institution_id uuid, institution_name text,
        first_name text, last_name text, photo_file_id uuid,
        class_name text, section_name text, child_blocked boolean, students_blocked boolean
      )
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      caller_role text := current_setting('app.role_code', true);
      caller_person text := current_setting('app.person_id', true);
      caller_society text := current_setting('app.society_id', true);
      caller_institutions text := current_setting('app.institution_ids', true);
      link record;
    begin
      perform set_config('app.role_code', '1', true);
      perform set_config('app.person_id', person::text, true);
      for link in
        select g.student_id as sid, g.society_id as soc, g.institution_id as inst
        from student_guardians g
        where g.user_id = person and g.status = 1
        order by g.created_at, g.id
      loop
        perform set_config('app.society_id', link.soc::text, true);
        perform set_config('app.institution_ids', link.inst::text, true);
        return query
          select st.id, st.society_id, st.institution_id, i.name::text,
            st.first_name::text, st.last_name::text, st.photo_file_id,
            place.class_name, place.section_name,
            st.access_blocked_at is not null,
            exists (
              select 1 from access_blocks b
              where b.society_id = st.society_id and b.institution_id = st.institution_id
                and b.section = 3 and b.lifted_at is null
            )
          from students st
          join institutions i on i.id = st.institution_id and i.status = 1
          join societies s on s.id = st.society_id and s.status = 1
          left join lateral (
            select c.display_name::text as class_name, sc.display_name::text as section_name
            from student_section_placements p
            join student_enrolments e on e.id = p.student_enrolment_id and e.status = 1
            join classes c on c.id = p.class_id
            join sections sc on sc.id = p.section_id
            where e.student_id = st.id and p.end_date is null
            limit 1
          ) place on true
          where st.id = link.sid and st.status = 1;
      end loop;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.person_id', coalesce(caller_person, ''), true);
      perform set_config('app.society_id', coalesce(caller_society, ''), true);
      perform set_config('app.institution_ids', coalesce(caller_institutions, ''), true);
    end;
    $$
  `.execute(db);
  await sql`revoke all on function app_children(uuid) from public`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function app_children(uuid) to erp_app;
      end if;
    end;
    $$
  `.execute(db);

  await sql`
    create policy students_select_child on students for select
      using (id = any (app_current_child_ids()))
  `.execute(db);
  await sql`
    create policy student_guardians_select_child on student_guardians for select
      using (student_id = any (app_current_child_ids()))
  `.execute(db);
  await sql`
    create policy student_enrolments_select_child on student_enrolments for select
      using (student_id = any (app_current_child_ids()))
  `.execute(db);
  await sql`
    create policy student_section_placements_select_child on student_section_placements for select
      using (
        student_enrolment_id in (
          select e.id from student_enrolments e where e.student_id = any (app_current_child_ids())
        )
      )
  `.execute(db);
  await sql`
    create policy student_achievements_select_child on student_achievements for select
      using (
        student_enrolment_id in (
          select e.id from student_enrolments e where e.student_id = any (app_current_child_ids())
        )
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): sign-in of parents relies on these.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop the parent context functions in production: parent sign-in relies on them',
    );
  }
  await sql`drop policy if exists student_achievements_select_child on student_achievements`.execute(
    db,
  );
  await sql`
    drop policy if exists student_section_placements_select_child on student_section_placements
  `.execute(db);
  await sql`drop policy if exists student_enrolments_select_child on student_enrolments`.execute(
    db,
  );
  await sql`drop policy if exists student_guardians_select_child on student_guardians`.execute(db);
  await sql`drop policy if exists students_select_child on students`.execute(db);
  await sql`drop function if exists app_children(uuid)`.execute(db);
  await sql`drop function if exists app_current_child_ids()`.execute(db);
}
