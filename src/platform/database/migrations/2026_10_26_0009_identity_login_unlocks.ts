import { sql, type Kysely } from 'kysely';

/**
 * Support unlock (PLT-41, API design 10.4d). `login_lockouts` is insert and
 * select only for the app role (DDD 9.1), so a lock cannot be shortened by
 * editing its row. An unlock is a row of its own: a lockout counts as lifted
 * when an unlock of the same email was recorded at or after it. The lockout
 * rows stay, so the 24-hour count of repeated lockouts is unchanged. Global like
 * the other identity tables (DDD 15.3).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table login_unlocks (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      email_hmac bytea not null,
      unlocked_by uuid not null references users (id),
      constraint ck_login_unlocks_hmac check (octet_length(email_hmac) = 32)
    )
  `.execute(db);
  await sql`create index ix_login_unlocks_email on login_unlocks (email_hmac, created_at desc)`.execute(
    db,
  );
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        grant select, insert on table login_unlocks to erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop login_unlocks in production: a lock that was lifted would apply again',
    );
  }
  await sql`drop table if exists login_unlocks`.execute(db);
}
