import { sql, type Kysely } from 'kysely';

/**
 * Events, part 2 (PRD 7.12, API design 5.4): a parent reads the calendar of their own child.
 *
 * - `events_select_child`: for role 5, an active event of the Society of one of the request's children (the
 *   `app.child_ids` setting that `ChildAccess` sets after it has checked the link) that is for everyone or for
 *   students and parents, and is the Society's or the child's own Institution's. It looks the child up in `students`
 *   under that table's own child policy, and no policy of `students` reads `events`, so there is no recursion. A parent
 *   in a request with no child, or any other role, matches nothing; a parent never reads a staff event, however the
 *   request is made, and never writes one.
 * - `event_holiday_classes_select_child`: the classes of a holiday, as far as the event is visible to the parent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create policy events_select_child on events for select using (
      app_current_role_code() = 5
      and status = 1
      and audience in (1, 2)
      and exists (
        select 1 from students s
        where s.id = any (app_current_child_ids())
          and s.society_id = events.society_id
          and (events.institution_id is null or events.institution_id = s.institution_id)
      )
    )
  `.execute(db);
  await sql`
    create policy event_holiday_classes_select_child on event_holiday_classes for select using (
      app_current_role_code() = 5
      and exists (select 1 from events e where e.id = event_holiday_classes.event_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): a parent's calendar relies on these.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop the parent event policies in production: parents read events through them',
    );
  }
  await sql`drop policy if exists event_holiday_classes_select_child on event_holiday_classes`.execute(
    db,
  );
  await sql`drop policy if exists events_select_child on events`.execute(db);
}
