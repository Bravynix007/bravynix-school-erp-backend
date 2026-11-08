import { sql, type Kysely } from 'kysely';

/**
 * File metadata (DDD 9.12, 16): one row per stored object; the content never enters the database. An owning
 * record points at its file (a student's photo, a document), and the row says which purpose it serves, so
 * who may upload and who may fetch a link follows from the purpose (API design 15.2).
 *
 * `ck_files_public_purpose` keeps the rule that only logos, event images and banners are public. The object key
 * is unique and never leaves the server. A file is Pending until the upload is confirmed (then Ready or Rejected),
 * and Deleted once its object is removed; `delete_after` is when an abandoned upload, an import or an export is
 * swept away.
 *
 * Row-level security (DDD 15.3): the caller's Society, and for a file of an Institution one the caller reaches.
 * The rows are kept (the object is what is removed), so the app role has no DELETE right.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table files (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      society_id uuid not null references societies (id) on delete restrict,
      institution_id uuid,
      storage_bucket smallint not null,
      object_key varchar(300) not null,
      purpose smallint not null,
      content_type varchar(100) not null,
      size_bytes integer not null,
      original_filename varchar(255),
      checksum_sha256 bytea,
      file_status smallint not null default 1,
      confirmed_at timestamptz,
      delete_after timestamptz,
      deleted_at timestamptz,
      constraint fk_files_institution foreign key (institution_id, society_id)
        references institutions (id, society_id) on delete restrict,
      constraint uq_files_object_key unique (object_key),
      constraint uq_files_id_society unique (id, society_id),
      constraint ck_files_bucket check (storage_bucket in (1, 2)),
      constraint ck_files_purpose check (purpose between 1 and 14),
      constraint ck_files_public_purpose check ((storage_bucket = 2) = (purpose in (1, 2, 10, 11))),
      constraint ck_files_content_type check (
        content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv')
      ),
      constraint ck_files_size check (size_bytes > 0 and (size_bytes <= 5242880 or purpose = 13)),
      constraint ck_files_status check (file_status in (1, 2, 3, 4))
    )
  `.execute(db);
  await sql`
    create index ix_files_cleanup on files (delete_after)
      where file_status in (1, 2) and delete_after is not null
  `.execute(db);

  const inScope = sql`
    society_id = app_current_society_id()
    and (institution_id is null or institution_id = any (app_current_institution_ids()))
  `;
  await sql`alter table files enable row level security`.execute(db);
  await sql`alter table files force row level security`.execute(db);
  await sql`create policy files_select on files for select using (${inScope})`.execute(db);
  await sql`create policy files_insert on files for insert with check (${inScope})`.execute(db);
  await sql`create policy files_update on files for update using (${inScope}) with check (${inScope})`.execute(
    db,
  );
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table files from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): students, staff and documents refer to files.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop files in production: later tables refer to it');
  }
  await sql`drop table if exists files`.execute(db);
}
