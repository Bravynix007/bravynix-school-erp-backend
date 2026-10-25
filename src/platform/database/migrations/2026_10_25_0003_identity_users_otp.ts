import { sql, type Kysely } from 'kysely';

/**
 * Identity, part 1 (DDD 9.1): `users`, `role_assignments` and
 * `otp_challenges`. These tables are global, because one person can act in
 * several Societies, so they carry no row-level security (DDD 15.3 "None");
 * only the Identity module's repositories touch them, which
 * `npm run lint:boundaries` enforces.
 *
 * The composite foreign keys from `role_assignments` to `institutions` and
 * `staff_members` are added by the migrations that create those tables
 * (tenancy, people); until then role 3 grants cannot be written by the app.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table users (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      updated_at timestamptz not null default now(),
      updated_by uuid references users (id),
      version integer not null default 1,
      email varchar(254) not null,
      first_name varchar(100),
      last_name varchar(100),
      country_code varchar(4),
      phone_number varchar(15),
      account_status smallint not null default 3,
      preferred_language varchar(5) not null default 'en',
      failed_login_count smallint not null default 0,
      locked_until timestamptz,
      first_login_at timestamptz,
      last_login_at timestamptz,
      blocked_at timestamptz,
      blocked_by uuid references users (id),
      block_reason varchar(500),
      constraint uq_users_email unique (email),
      constraint ck_users_email check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
      constraint ck_users_status check (account_status in (0, 1, 2, 3)),
      constraint ck_users_language check (preferred_language in ('en', 'hi', 'kn', 'ml', 'mr', 'ta', 'te')),
      constraint ck_users_failed_login_count check (failed_login_count >= 0),
      constraint ck_users_country_code check (country_code ~ '^[0-9]{1,4}$'),
      constraint ck_users_phone_number check (phone_number ~ '^[0-9]{6,15}$'),
      constraint ck_users_phone_pair check ((country_code is null) = (phone_number is null)),
      constraint ck_users_blocked check ((account_status = 2) = (blocked_at is not null))
    )
  `.execute(db);
  await sql`
    create trigger trg_users_updated before update on users
      for each row execute function set_updated_at()
  `.execute(db);
  await sql`
    create trigger trg_users_version before update on users
      for each row execute function bump_version()
  `.execute(db);

  await sql`
    create table role_assignments (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by uuid references users (id),
      user_id uuid not null references users (id),
      role_code smallint not null,
      society_id uuid,
      institution_id uuid,
      staff_member_id uuid,
      seat_no smallint,
      revoked_at timestamptz,
      revoked_by uuid references users (id),
      revoke_reason varchar(500),
      constraint ck_role_assignments_role check (role_code in (1, 2, 3)),
      constraint ck_role_assignments_seat check (seat_no between 1 and 3),
      constraint ck_role_assignments_scope check (
        (role_code = 1 and society_id is null and institution_id is null
          and staff_member_id is null and seat_no is not null)
        or (role_code = 2 and society_id is not null and institution_id is null
          and staff_member_id is null and seat_no is not null)
        or (role_code = 3 and society_id is not null and institution_id is not null
          and staff_member_id is not null and seat_no is null)
      ),
      constraint ck_role_assignments_revoke check (
        revoked_at is not null or (revoked_by is null and revoke_reason is null)
      )
    )
  `.execute(db);
  // At most 3 active Super Admins, and 3 active Society Owners per Society,
  // enforced by the database (decision 19).
  await sql`
    create unique index uq_role_assignments_super_admin_seat on role_assignments (seat_no)
      where role_code = 1 and revoked_at is null
  `.execute(db);
  await sql`
    create unique index uq_role_assignments_owner_seat on role_assignments (society_id, seat_no)
      where role_code = 2 and revoked_at is null
  `.execute(db);
  // No duplicate active grants; also serves the per-request lookup by person.
  await sql`
    create unique index uq_role_assignments_active_grant
      on role_assignments (user_id, role_code, society_id, institution_id) nulls not distinct
      where revoked_at is null
  `.execute(db);
  await sql`
    create index ix_role_assignments_institution_admins on role_assignments (institution_id)
      where role_code = 3 and revoked_at is null
  `.execute(db);

  await sql`
    create table otp_challenges (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      email_hmac bytea not null,
      user_id uuid references users (id),
      code_hmac bytea,
      purpose smallint not null default 1,
      expires_at timestamptz not null,
      attempt_count smallint not null default 0,
      consumed_at timestamptz,
      superseded_at timestamptz,
      request_ip inet,
      locked_until timestamptz,
      constraint ck_otp_challenges_email_hmac check (octet_length(email_hmac) = 32),
      constraint ck_otp_challenges_code_hmac check (code_hmac is null or octet_length(code_hmac) = 32),
      constraint ck_otp_challenges_account check ((user_id is null) = (code_hmac is null)),
      constraint ck_otp_challenges_purpose check (purpose in (1, 2)),
      constraint ck_otp_challenges_attempts check (attempt_count between 0 and 5)
    )
  `.execute(db);
  // Counts requests in the last 15 minutes, checks the 60-second gap and finds
  // the live code (DDD 9.1).
  await sql`
    create index ix_otp_challenges_email_created on otp_challenges (email_hmac, created_at desc)
  `.execute(db);
  // The per-IP limit on unauthenticated calls (API design 6.2).
  await sql`
    create index ix_otp_challenges_ip_created on otp_challenges (request_ip, created_at desc)
      where request_ip is not null
  `.execute(db);
  // The 24-hour sweep (DDD 14.5).
  await sql`create index ix_otp_challenges_created on otp_challenges (created_at)`.execute(db);

  // Role grants are never deleted; revoking sets the revoke columns.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'erp_app') then
        revoke delete, truncate on table role_assignments from erp_app;
        revoke truncate on table users, otp_challenges from erp_app;
      end if;
    end;
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // People and their grants are the system of record for who may sign in;
  // production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the identity tables in production: they hold every account');
  }
  await sql`drop table if exists otp_challenges`.execute(db);
  await sql`drop table if exists role_assignments`.execute(db);
  await sql`drop table if exists users`.execute(db);
}
