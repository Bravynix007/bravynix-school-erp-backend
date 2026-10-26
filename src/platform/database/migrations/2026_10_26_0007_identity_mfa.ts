import { sql, type Kysely } from 'kysely';

/**
 * Identity, part 3 (DDD 9.1, API design 10.2 to 10.2c): the Super Admin
 * authenticator. `user_totp_factors` holds the encrypted secret; a factor
 * counts once confirmed, and `last_used_step` stops a code being used twice.
 * `mfa_challenges` is the step between the email code and the session: the
 * email code is spent, and a 5-minute token (stored only as a keyed hash)
 * stands for "this person passed the first step" until the authenticator code
 * is given. Both tables are global like the other identity tables (DDD 15.3).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_totp_factors (
      user_id uuid primary key references users (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      secret_ciphertext bytea not null,
      secret_key_version smallint not null,
      confirmed_at timestamptz,
      last_used_step bigint,
      constraint ck_user_totp_factors_step check (last_used_step is null or confirmed_at is not null)
    )
  `.execute(db);
  await sql`
    create trigger trg_user_totp_factors_updated before update on user_totp_factors
      for each row execute function set_updated_at()
  `.execute(db);

  await sql`
    create table mfa_challenges (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      user_id uuid not null references users (id),
      token_hmac bytea not null,
      expires_at timestamptz not null,
      used_at timestamptz,
      failed_tries smallint not null default 0,
      constraint uq_mfa_challenges_token unique (token_hmac),
      constraint ck_mfa_challenges_hmac check (octet_length(token_hmac) = 32),
      constraint ck_mfa_challenges_tries check (failed_tries >= 0)
    )
  `.execute(db);
  await sql`create index ix_mfa_challenges_user on mfa_challenges (user_id, created_at desc)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop the authenticator tables in production: they hold every Super Admin factor',
    );
  }
  await sql`drop table if exists mfa_challenges`.execute(db);
  await sql`drop table if exists user_totp_factors`.execute(db);
}
