import { sql, type Kysely } from 'kysely';

/**
 * People, part 5 (DDD 9.5, 9.6, 15.6): a staff member's Aadhaar number and the documents attached to a record.
 *
 * - `staff_identities`: one row per staff member, made when an admin first sets the number (STF-11) and kept when it
 *   is cleared, so every column but the key may be empty. The number is sealed (AES-256-GCM, bound to its row), found
 *   by a keyed hash and masked by its last four digits; the plain number is never stored. The bank account, IFSC and
 *   branch of the design are not built (BravyNix, 9 Nov: the product does not use them), so there is no bank column to
 *   drop later. `uq_staff_identities_society_aadhaar` keeps one record per number in a Society; the service releases
 *   the number of a deactivated record to a new claim, so a person who is added again can be given it.
 * - `documents`: a file attached to a staff member (STF-15), soft-deleted by `status` (DOC-03). The student side
 *   (`owner_type` 1, `student_id`) arrives with the students table in B7, which widens `ck_documents_owner`. A file
 *   is attached once (`uq_documents_file`), also after its document is deactivated.
 *
 * `staff_identities` uses the Society-level policy of the other staff tables, as the design lists no Institution on
 * it; `documents` carries the staff member's home Institution (a composite key to `uq_staff_members_id_home`) and
 * the Institution-level policy, because the file and the admin who may open it are the Institution's.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table staff_identities (
      staff_member_id uuid primary key,
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      society_id uuid not null,
      aadhaar_ciphertext bytea,
      aadhaar_key_version smallint,
      aadhaar_hmac bytea,
      aadhaar_last4 char(4),
      constraint fk_staff_identities_staff foreign key (staff_member_id, society_id)
        references staff_members (id, society_id) on delete restrict,
      constraint ck_staff_identities_aadhaar_complete check (
        (aadhaar_ciphertext is null) = (aadhaar_key_version is null)
        and (aadhaar_ciphertext is null) = (aadhaar_hmac is null)
        and (aadhaar_ciphertext is null) = (aadhaar_last4 is null)
      ),
      constraint ck_staff_identities_aadhaar_hmac check (aadhaar_hmac is null or length(aadhaar_hmac) = 32),
      constraint ck_staff_identities_aadhaar_last4 check (aadhaar_last4 is null or aadhaar_last4 ~ '^[0-9]{4}$')
    )
  `.execute(db);
  await sql`
    create unique index uq_staff_identities_society_aadhaar
      on staff_identities (society_id, aadhaar_hmac) where aadhaar_hmac is not null
  `.execute(db);
  await sql`
    create trigger trg_staff_identities_updated before update on staff_identities
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_staff_identities_version before update on staff_identities
      for each row execute function bump_version()
  `.execute(db);

  await sql`
    create table documents (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      status smallint not null default 1,
      society_id uuid not null,
      institution_id uuid not null,
      owner_type smallint not null,
      staff_member_id uuid,
      title varchar(150) not null,
      file_id uuid not null,
      constraint fk_documents_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint fk_documents_staff foreign key (staff_member_id, institution_id)
        references staff_members (id, home_institution_id) on delete restrict,
      constraint fk_documents_file foreign key (file_id, society_id)
        references files (id, society_id) on delete restrict,
      constraint uq_documents_file unique (file_id),
      constraint ck_documents_status check (status in (0, 1)),
      constraint ck_documents_title check (btrim(title) <> ''),
      constraint ck_documents_owner check (owner_type = 2 and staff_member_id is not null)
    )
  `.execute(db);
  await sql`
    create index ix_documents_staff on documents (staff_member_id, created_at desc, id desc)
      where status = 1
  `.execute(db);
  await sql`
    create trigger trg_documents_updated before update on documents
      for each row execute function set_updated_at()
  `.execute(db);

  const identities = sql.table('staff_identities');
  await sql`alter table ${identities} enable row level security`.execute(db);
  await sql`alter table ${identities} force row level security`.execute(db);
  await sql`
    create policy staff_identities_select on ${identities} for select
      using (society_id = app_current_society_id())
  `.execute(db);
  await sql`
    create policy staff_identities_insert on ${identities} for insert
      with check (society_id = app_current_society_id())
  `.execute(db);
  await sql`
    create policy staff_identities_update on ${identities} for update
      using (society_id = app_current_society_id()) with check (society_id = app_current_society_id())
  `.execute(db);

  const inScope = sql`
    society_id = app_current_society_id() and institution_id = any (app_current_institution_ids())
  `;
  const documents = sql.table('documents');
  await sql`alter table ${documents} enable row level security`.execute(db);
  await sql`alter table ${documents} force row level security`.execute(db);
  await sql`create policy documents_select on ${documents} for select using (${inScope})`.execute(
    db,
  );
  await sql`create policy documents_insert on ${documents} for insert with check (${inScope})`.execute(
    db,
  );
  await sql`
    create policy documents_update on ${documents} for update using (${inScope}) with check (${inScope})
  `.execute(db);
  // A document is deactivated, never deleted; the file, the owner and the Institution it was made for never change.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke update, delete, truncate on table documents from erp_app;
        grant update (status, updated_at, updated_by) on table documents to erp_app;
        revoke delete, truncate on table staff_identities from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the students' documents and payroll refer to these tables.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop identities and documents in production');
  }
  await sql`drop table if exists documents`.execute(db);
  await sql`drop table if exists staff_identities`.execute(db);
}
