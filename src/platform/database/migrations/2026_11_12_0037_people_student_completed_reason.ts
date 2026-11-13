import { sql, type Kysely } from 'kysely';

/**
 * People, part 12 (DDD 9.6): a student who completes the final class is deactivated by the promotion, with
 * `inactive_reason` 4 Completed the final class, beside 1 Left, 2 Created by mistake and 3 Other. STU-05 still takes
 * only 1 to 3, so reason 4 is set by promotion alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table students
      drop constraint ck_students_inactive,
      add constraint ck_students_inactive check (
        (status = 1 and inactive_reason is null and inactive_at is null)
        or (status = 0 and inactive_reason is not null and inactive_reason between 1 and 4
          and inactive_at is not null)
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the Completed deactivation reason in production');
  }
  // The table forces row-level security and this role sets no tenant, so the update would see no row and the new check
  // would then fail: lift the force for the update, inside this migration's own transaction.
  await sql`alter table students no force row level security`.execute(db);
  await sql`update students set inactive_reason = 3 where inactive_reason = 4`.execute(db);
  await sql`alter table students force row level security`.execute(db);
  await sql`
    alter table students
      drop constraint ck_students_inactive,
      add constraint ck_students_inactive check (
        (status = 1 and inactive_reason is null and inactive_at is null)
        or (status = 0 and inactive_reason is not null and inactive_reason between 1 and 3
          and inactive_at is not null)
      )
  `.execute(db);
}
