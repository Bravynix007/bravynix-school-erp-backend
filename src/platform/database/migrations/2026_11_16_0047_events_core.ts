import { sql, type Kysely } from 'kysely';

/**
 * Events and holidays (DDD 9.8, PRD 7.12): `events` and `event_holiday_classes`.
 *
 * - `events`: dated, not tied to an academic year. Scope 1 belongs to the Society and shows in every Institution of
 *   it; scope 2 belongs to one Institution (`institution_id` is set exactly when `scope` is 2, and the pair is a
 *   foreign key to `institutions`, so an Institution of another Society cannot be named). A holiday says its type and
 *   who it is for (at least one of students and staff); a plain event says none of that. Soft delete only, so the app
 *   role has no DELETE right.
 * - Row-level security: a person reads the events of their Society that are Society-wide or in an Institution of
 *   their scope. A write needs an Institution of their scope, or, for a Society-wide event, the Society Owner (role
 *   2), so an Institution Admin cannot make or change one even by a path that skips the service.
 * - `event_holiday_classes`: the predefined classes a holiday is limited to ("Holiday up to 8th Grade"); no rows mean
 *   every class. Replaced as a set when the event is edited, so it is hard-deleted, and it is read and written only
 *   as far as the event is.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table events (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      status smallint not null default 1,
      society_id uuid not null references societies (id) on delete restrict,
      scope smallint not null,
      institution_id uuid,
      title varchar(150) not null,
      description varchar(2000),
      venue varchar(200),
      start_date date not null,
      end_date date not null,
      duration_label varchar(50) not null,
      audience smallint not null default 1,
      preset_image_code varchar(30),
      is_holiday boolean not null default false,
      holiday_type smallint,
      holiday_for_students boolean not null default false,
      holiday_for_staff boolean not null default false,
      constraint uq_events_id_society unique (id, society_id),
      constraint fk_events_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint ck_events_status check (status in (0, 1)),
      constraint ck_events_scope check (scope in (1, 2)),
      constraint ck_events_scope_institution check ((scope = 2) = (institution_id is not null)),
      constraint ck_events_title check (btrim(title) <> ''),
      constraint ck_events_duration_label check (btrim(duration_label) <> ''),
      constraint ck_events_dates check (end_date >= start_date),
      constraint ck_events_audience check (audience in (1, 2, 3)),
      constraint ck_events_holiday_type check (
        (is_holiday and holiday_type between 1 and 4) or (not is_holiday and holiday_type is null)
      ),
      constraint ck_events_holiday_for check (
        (is_holiday and (holiday_for_students or holiday_for_staff))
        or (not is_holiday and not holiday_for_students and not holiday_for_staff)
      )
    )
  `.execute(db);
  await sql`
    create index ix_events_society_start on events (society_id, start_date) where status = 1
  `.execute(db);
  await sql`
    create index ix_events_holidays on events (society_id, start_date, end_date)
      where status = 1 and is_holiday
  `.execute(db);
  await sql`
    create trigger trg_events_updated before update on events
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_events_version before update on events
      for each row execute function bump_version()
  `.execute(db);

  await sql`alter table events enable row level security`.execute(db);
  await sql`alter table events force row level security`.execute(db);
  await sql`
    create policy events_select on events for select using (
      society_id = app_current_society_id()
      and (institution_id is null or institution_id = any (app_current_institution_ids()))
    )
  `.execute(db);
  const writable = sql`
    society_id = app_current_society_id()
    and (
      institution_id = any (app_current_institution_ids())
      or (institution_id is null and app_current_role_code() = 2)
    )
  `;
  await sql`create policy events_insert on events for insert with check (${writable})`.execute(db);
  await sql`
    create policy events_update on events for update using (${writable}) with check (${writable})
  `.execute(db);

  await sql`
    create table event_holiday_classes (
      event_id uuid not null,
      predefined_class_id uuid not null references predefined_classes (id) on delete restrict,
      society_id uuid not null,
      constraint pk_event_holiday_classes primary key (event_id, predefined_class_id),
      constraint fk_event_holiday_classes_event foreign key (event_id, society_id)
        references events (id, society_id) on delete restrict
    )
  `.execute(db);
  await sql`alter table event_holiday_classes enable row level security`.execute(db);
  await sql`alter table event_holiday_classes force row level security`.execute(db);
  // Read and written as far as the event is: the subquery reads `events` under its own policies, and none of them reads this table.
  const ofVisibleEvent = sql`
    event_holiday_classes.society_id = app_current_society_id()
    and exists (
      select 1 from events e
      where e.id = event_holiday_classes.event_id and e.society_id = event_holiday_classes.society_id
    )
  `;
  await sql`
    create policy event_holiday_classes_select on event_holiday_classes for select using (${ofVisibleEvent})
  `.execute(db);
  await sql`
    create policy event_holiday_classes_insert on event_holiday_classes for insert with check (${ofVisibleEvent})
  `.execute(db);
  await sql`
    create policy event_holiday_classes_delete on event_holiday_classes for delete using (${ofVisibleEvent})
  `.execute(db);

  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table events from erp_app;
        revoke update, truncate on table event_holiday_classes from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the school's calendar lives here.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop events in production: it holds the school calendars');
  }
  await sql`drop table if exists event_holiday_classes`.execute(db);
  await sql`drop table if exists events`.execute(db);
}
