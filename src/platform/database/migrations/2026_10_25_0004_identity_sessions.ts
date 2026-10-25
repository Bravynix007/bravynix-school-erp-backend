import { sql, type Kysely } from 'kysely';

/**
 * Identity, part 2 (DDD 9.1): `auth_sessions` and `refresh_tokens`. Global
 * like the other identity tables (DDD 15.3 "None"). A refresh token belongs to
 * a session, so presenting a used one can end exactly that session.
 *
 * `active_society_id` is not in DDD 9.1 yet: the token needs the Society of the
 * active context, and a refresh must restore it without asking again. The DDD
 * is updated with this change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table auth_sessions (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      user_id uuid not null references users (id),
      client_type smallint not null,
      active_role_code smallint,
      active_society_id uuid,
      last_used_at timestamptz not null default now(),
      idle_expires_at timestamptz not null,
      absolute_expires_at timestamptz,
      ended_at timestamptz,
      end_reason smallint,
      ip_address inet,
      user_agent varchar(300),
      device_label varchar(100),
      constraint ck_auth_sessions_client check (client_type in (1, 2)),
      constraint ck_auth_sessions_role check (active_role_code is null or active_role_code between 1 and 5),
      constraint ck_auth_sessions_end check ((ended_at is null) = (end_reason is null)),
      constraint ck_auth_sessions_end_reason check (end_reason is null or end_reason between 1 and 7),
      constraint ck_auth_sessions_console_limit check (client_type = 1 or absolute_expires_at is not null)
    )
  `.execute(db);
  // Log out of all devices, blocking and revoking find a person's open sessions.
  await sql`
    create index ix_auth_sessions_user_open on auth_sessions (user_id) where ended_at is null
  `.execute(db);
  // The daily sweep of sessions that ended more than 30 days ago (DDD 14.2).
  await sql`
    create index ix_auth_sessions_ended on auth_sessions (ended_at) where ended_at is not null
  `.execute(db);

  await sql`
    create table refresh_tokens (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      session_id uuid not null references auth_sessions (id) on delete cascade,
      token_hmac bytea not null,
      expires_at timestamptz not null,
      used_at timestamptz,
      constraint uq_refresh_tokens_token_hmac unique (token_hmac),
      constraint ck_refresh_tokens_hmac check (octet_length(token_hmac) = 32)
    )
  `.execute(db);
  await sql`create index ix_refresh_tokens_session on refresh_tokens (session_id)`.execute(db);

  // Sessions end, they are not deleted by the app; a platform job sweeps them.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table auth_sessions, refresh_tokens from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the session tables in production: they hold every login');
  }
  await sql`drop table if exists refresh_tokens`.execute(db);
  await sql`drop table if exists auth_sessions`.execute(db);
}
