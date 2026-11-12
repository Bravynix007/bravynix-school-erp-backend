import { sql, type Kysely } from 'kysely';

/**
 * People, part 7 (DDD 9.6): why and when a student was deactivated. `inactive_reason` is 1 Left the Institution,
 * 2 Created by mistake, 3 Other, and is required exactly when the record is deactivated (`status` 0), so a
 * deactivated student always says why. The Admission ID and the roll number are free again once the record is
 * deactivated (migration 0031).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table students
      add column inactive_reason smallint,
      add column inactive_at timestamptz,
      add constraint ck_students_inactive check (
        (status = 1 and inactive_reason is null and inactive_at is null)
        or (status = 0 and inactive_reason is not null and inactive_reason between 1 and 3
          and inactive_at is not null)
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the deactivation columns in production');
  }
  await sql`
    alter table students
      drop constraint if exists ck_students_inactive,
      drop column if exists inactive_at,
      drop column if exists inactive_reason
  `.execute(db);
}
