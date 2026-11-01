import { sql, type Kysely } from 'kysely';

/**
 * Two small pieces every money-handling module shares (DDD 9.1, 9.8; API design
 * 14): the stored answers behind an `Idempotency-Key`, and the gap-free
 * counters behind receipt, enquiry and platform invoice numbers.
 *
 * `idempotency_keys` has no tenant column: a key belongs to the person who sent
 * it, and row-level security lets a person read and write only their own
 * (DDD 15.3, the person family), because the stored answers will hold dues,
 * invoices and receipts. Nobody else reads them, Super Admin included. The
 * hourly sweep is a maintenance function that runs as the table owner, who is
 * not bound by the policies (the table is not FORCEd for that reason; the app
 * role is not the owner, so it is always bound). It deletes only answers past
 * their 24 hours, by the database clock.
 *
 * `number_sequences` rows are never deleted. Platform invoices (type 3) belong
 * to no Society, so only Super Admin may touch them; receipts and enquiries
 * (types 1 and 2) are per Institution and reachable inside it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table idempotency_keys (
      user_id uuid not null references users (id) on delete cascade,
      idempotency_key uuid not null,
      operation varchar(60) not null,
      request_fingerprint bytea not null,
      response_status smallint not null,
      response_body jsonb not null,
      resource_id uuid,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      primary key (user_id, idempotency_key),
      constraint ck_idempotency_keys_status check (response_status between 200 and 499),
      constraint ck_idempotency_keys_life check (expires_at > created_at)
    )
  `.execute(db);
  await sql`create index ix_idempotency_keys_expires on idempotency_keys (expires_at)`.execute(db);

  await sql`alter table idempotency_keys enable row level security`.execute(db);
  await sql`
    create policy idempotency_keys_select on idempotency_keys for select
      using (user_id = app_current_person_id())
  `.execute(db);
  await sql`
    create policy idempotency_keys_insert on idempotency_keys for insert
      with check (user_id = app_current_person_id())
  `.execute(db);
  await sql`
    create policy idempotency_keys_delete on idempotency_keys for delete
      using (user_id = app_current_person_id())
  `.execute(db);
  await sql`
    create function maintenance.sweep_idempotency_keys() returns bigint
    language sql
    security definer
    set search_path = pg_catalog, pg_temp
    as $$
      with removed as (
        delete from public.idempotency_keys where expires_at <= now() returning 1
      )
      select count(*) from removed
    $$
  `.execute(db);
  await sql`revoke all on function maintenance.sweep_idempotency_keys() from public`.execute(db);

  await sql`
    create table number_sequences (
      id uuid primary key default gen_random_uuid(),
      updated_at timestamptz not null default now(),
      sequence_type smallint not null,
      society_id uuid references societies (id) on delete restrict,
      institution_id uuid,
      period_key varchar(12) not null,
      prefix varchar(30) not null,
      next_value bigint not null default 1,
      constraint fk_number_sequences_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint ck_number_sequences_type check (sequence_type in (1, 2, 3)),
      constraint ck_number_sequences_scope check (
        (sequence_type = 3) = (society_id is null and institution_id is null)
        and (society_id is null) = (institution_id is null)
      ),
      constraint ck_number_sequences_next check (next_value >= 1),
      constraint uq_number_sequences_scope unique nulls not distinct (sequence_type, institution_id, period_key)
    )
  `.execute(db);
  // The app role may update next_value, but only to hand out the next number:
  // a rewind would reissue a number, a jump would leave a gap.
  await sql`
    create function number_sequences_step() returns trigger
    language plpgsql as $$
    begin
      if new.next_value <> old.next_value + 1 then
        raise exception 'number_sequences.next_value moves up by exactly one'
          using errcode = 'check_violation';
      end if;
      return new;
    end;
    $$
  `.execute(db);
  await sql`
    create trigger trg_number_sequences_step before update on number_sequences
      for each row execute function number_sequences_step()
  `.execute(db);
  await sql`
    create trigger trg_number_sequences_updated before update on number_sequences
      for each row execute function set_updated_at()
  `.execute(db);

  await sql`alter table number_sequences enable row level security`.execute(db);
  await sql`alter table number_sequences force row level security`.execute(db);
  await sql`
    create policy number_sequences_all on number_sequences for all
      using (
        app_is_super_admin()
        or (
          institution_id is not null
          and society_id = app_current_society_id()
          and institution_id = any (app_current_institution_ids())
        )
      )
      with check (
        app_is_super_admin()
        or (
          institution_id is not null
          and society_id = app_current_society_id()
          and institution_id = any (app_current_institution_ids())
        )
      )
  `.execute(db);

  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        -- A counter is never deleted, and a number is only ever taken, not set.
        revoke delete, truncate on table number_sequences from erp_app;
        revoke update on table number_sequences from erp_app;
        grant update (next_value, updated_at) on table number_sequences to erp_app;
        -- A stored answer is never edited; the hourly sweep deletes it.
        revoke update, truncate on table idempotency_keys from erp_app;
        -- The sweep only removes answers past their time, so the app may run it.
        grant usage on schema maintenance to erp_app;
        grant execute on function maintenance.sweep_idempotency_keys() to erp_app;
      end if;
      if exists (select 1 from pg_roles where rolname = 'erp_platform') then
        grant usage on schema maintenance to erp_platform;
        grant execute on function maintenance.sweep_idempotency_keys() to erp_platform;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6), and a counter dropped would reissue numbers.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop number_sequences in production: it holds issued numbers');
  }
  await sql`drop table if exists number_sequences`.execute(db);
  await sql`drop function if exists number_sequences_step()`.execute(db);
  await sql`drop function if exists maintenance.sweep_idempotency_keys()`.execute(db);
  await sql`drop table if exists idempotency_keys`.execute(db);
}
