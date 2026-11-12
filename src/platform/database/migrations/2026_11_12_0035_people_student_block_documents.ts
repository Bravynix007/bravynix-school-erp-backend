import { sql, type Kysely } from 'kysely';

/**
 * People, part 9 (DDD 9.6, D-02): the block on a student's profile, and the documents of a student.
 *
 * - `students.access_blocked_at` and `access_blocked_by`: a block from the student's profile (STU-06). The guardians lose
 *   access to this child only; the siblings stay visible. Both set or both empty, as on `staff_members` (migration
 *   0027).
 * - `documents.student_id`: the student side of the table of migration 0030 (`owner_type` 1). The composite key to
 *   `uq_students_id_institution` keeps a document in its student's Institution, and `ck_documents_owner` now accepts
 *   exactly the owner column that matches `owner_type`. The app role may still change only `status`, `updated_at` and
 *   `updated_by`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table students
      add column access_blocked_at timestamptz,
      add column access_blocked_by uuid references users (id),
      add constraint ck_students_access_block
        check ((access_blocked_at is null) = (access_blocked_by is null))
  `.execute(db);

  await sql`
    alter table documents
      add column student_id uuid,
      add constraint fk_documents_student foreign key (student_id, institution_id)
        references students (id, institution_id) on delete restrict,
      drop constraint ck_documents_owner,
      add constraint ck_documents_owner check (
        (owner_type = 1 and student_id is not null and staff_member_id is null)
        or (owner_type = 2 and staff_member_id is not null and student_id is null)
      )
  `.execute(db);
  await sql`
    create index ix_documents_student on documents (student_id, created_at desc, id desc)
      where status = 1
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): the documents of students refer to these columns.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to drop the student block and documents in production');
  }
  await sql`drop index if exists ix_documents_student`.execute(db);
  // The table forces row-level security and has no DELETE policy, so even its owner sees no row to delete: lift the
  // force for these two statements, inside this migration's own transaction.
  await sql`alter table documents no force row level security`.execute(db);
  await sql`delete from documents where owner_type = 1`.execute(db);
  await sql`alter table documents force row level security`.execute(db);
  await sql`
    alter table documents
      drop constraint ck_documents_owner,
      add constraint ck_documents_owner check (owner_type = 2 and staff_member_id is not null),
      drop constraint fk_documents_student,
      drop column student_id
  `.execute(db);
  await sql`
    alter table students
      drop constraint if exists ck_students_access_block,
      drop column if exists access_blocked_by,
      drop column if exists access_blocked_at
  `.execute(db);
}
