import { sql, type Kysely } from 'kysely';

/**
 * People, part 7 (DDD 9.6, 15.6): a student's Aadhaar number and birth certificate number.
 *
 * - `student_identities`: one row per student, made when an admin first sets a number (STU-02 or STU-10) and kept when
 *   the numbers are cleared, so every column but the key may be empty. The Aadhaar number is sealed (AES-256-GCM, bound
 *   to its row), found by a keyed hash and masked by its last four digits, exactly as on `staff_identities`
 *   (migration 0030); the birth certificate number is kept as typed, because ordinary screens show it (DDD 15.6, not
 *   covered by ADR-09). The bank account of the first design is not built.
 * - `uq_student_identities_institution_aadhaar` keeps one record per number in an Institution, so the same child is
 *   not added twice; the service releases the number of a deactivated student to a new claim. The index on the Society
 *   and the hash serves the other question, whether the child already stands at another Institution of the Society
 *   (a transfer, which warns and never blocks).
 * - `app_student_aadhaar_elsewhere(institution, hash)` answers that question. Row-level security shows an Institution
 *   Admin no other Institution's rows, so a definer function reads them and answers the one boolean. It looks only in
 *   the caller's own Society (a Society the caller is not in is never asked about), like the functions of migrations
 *   0011 and 0031 it acts as Super Admin for the read, puts the caller's settings back before it returns, has a fixed
 *   search_path, and only the app role may call it.
 *
 * The table uses the Institution-level policy of the other student tables (DDD 15.3).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table student_identities (
      student_id uuid primary key,
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      society_id uuid not null,
      institution_id uuid not null,
      aadhaar_ciphertext bytea,
      aadhaar_key_version smallint,
      aadhaar_hmac bytea,
      aadhaar_last4 char(4),
      birth_certificate_number varchar(50),
      constraint fk_student_identities_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_student_identities_student foreign key (student_id, institution_id)
        references students (id, institution_id) on delete restrict,
      constraint ck_student_identities_aadhaar_complete check (
        (aadhaar_ciphertext is null) = (aadhaar_key_version is null)
        and (aadhaar_ciphertext is null) = (aadhaar_hmac is null)
        and (aadhaar_ciphertext is null) = (aadhaar_last4 is null)
      ),
      constraint ck_student_identities_aadhaar_hmac check (aadhaar_hmac is null or length(aadhaar_hmac) = 32),
      constraint ck_student_identities_aadhaar_last4 check (aadhaar_last4 is null or aadhaar_last4 ~ '^[0-9]{4}$'),
      constraint ck_student_identities_birth_certificate
        check (birth_certificate_number is null or btrim(birth_certificate_number) <> '')
    )
  `.execute(db);
  await sql`
    create unique index uq_student_identities_institution_aadhaar
      on student_identities (institution_id, aadhaar_hmac) where aadhaar_hmac is not null
  `.execute(db);
  await sql`
    create index ix_student_identities_society_aadhaar
      on student_identities (society_id, aadhaar_hmac) where aadhaar_hmac is not null
  `.execute(db);
  await sql`
    create trigger trg_student_identities_updated before update on student_identities
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_student_identities_version before update on student_identities
      for each row execute function bump_version()
  `.execute(db);

  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  const identities = sql.table('student_identities');
  await sql`alter table ${identities} enable row level security`.execute(db);
  await sql`alter table ${identities} force row level security`.execute(db);
  await sql`
    create policy student_identities_select on ${identities} for select using (${inScope})
  `.execute(db);
  await sql`
    create policy student_identities_insert on ${identities} for insert with check (${inScope})
  `.execute(db);
  await sql`
    create policy student_identities_update on ${identities} for update
      using (${inScope}) with check (${inScope})
  `.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table student_identities from erp_app;
      end if;
    end;
    $$
  `.execute(db);

  await sql`
    create function app_student_aadhaar_elsewhere(institution uuid, hash bytea) returns boolean
    language plpgsql volatile security definer
    set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      society uuid := app_current_society_id();
      caller_role text := current_setting('app.role_code', true);
      caller_institutions text := current_setting('app.institution_ids', true);
      found boolean;
    begin
      if society is null then
        return false;
      end if;
      perform set_config('app.role_code', '1', true);
      perform set_config(
        'app.institution_ids',
        coalesce(
          (select string_agg(i.id::text, ',') from institutions i
            where i.society_id = society and i.id <> institution),
          ''
        ),
        true
      );
      select exists (
        select 1 from student_identities s
        where s.society_id = society and s.institution_id <> institution and s.aadhaar_hmac = hash
      ) into found;
      perform set_config('app.role_code', coalesce(caller_role, ''), true);
      perform set_config('app.institution_ids', coalesce(caller_institutions, ''), true);
      return found;
    end;
    $$
  `.execute(db);
  await sql`revoke all on function app_student_aadhaar_elsewhere(uuid, bytea) from public`.execute(
    db,
  );
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant execute on function app_student_aadhaar_elsewhere(uuid, bytea) to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): later records refer to the student's identity.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop student identities in production');
  }
  await sql`drop function if exists app_student_aadhaar_elsewhere(uuid, bytea)`.execute(db);
  await sql`drop table if exists student_identities`.execute(db);
}
