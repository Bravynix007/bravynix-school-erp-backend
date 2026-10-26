import { sql, type Kysely } from 'kysely';

/**
 * Identity, part 3: the per-IP call counters get a scope, so the login-code
 * endpoints keep their strict 20 calls a minute while refresh has its own,
 * higher limit (owner decision, 26 Oct 2026: many people behind one school
 * Wi-Fi or mobile carrier address renew sessions in the same minute, and a
 * refresh token cannot be guessed). One row per scope, address and minute.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table public_call_counters add column scope smallint not null default 1`.execute(
    db,
  );
  await sql`
    alter table public_call_counters
      add constraint ck_public_call_counters_scope check (scope in (1, 2))
  `.execute(db);
  await sql`alter table public_call_counters drop constraint pk_public_call_counters`.execute(db);
  await sql`
    alter table public_call_counters
      add constraint pk_public_call_counters primary key (scope, ip, window_start)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop the call counter scope in production (production migrations only add)',
    );
  }
  // The counters are a minute-long cache (UNLOGGED); losing refresh rows loses nothing.
  await sql`delete from public_call_counters where scope <> 1`.execute(db);
  await sql`alter table public_call_counters drop constraint pk_public_call_counters`.execute(db);
  await sql`
    alter table public_call_counters add constraint pk_public_call_counters primary key (ip, window_start)
  `.execute(db);
  await sql`alter table public_call_counters drop constraint ck_public_call_counters_scope`.execute(
    db,
  );
  await sql`alter table public_call_counters drop column scope`.execute(db);
}
