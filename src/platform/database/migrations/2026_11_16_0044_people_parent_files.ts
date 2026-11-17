import { sql, type Kysely } from 'kysely';

/**
 * People, part 12 (API design 15.2, DDD 9.6): a parent opens the photo and the documents of their own child.
 *
 * Two read policies, both reading the one child a request carries (`app_current_child_ids()`, migration 0043):
 *
 * - `documents_select_child`: the active documents of that child.
 * - `files_select_child`: the file that is that child's photo (purpose 3) or one of that child's documents
 *   (purpose 5) while the document is active. Neither policy reads the table it guards, so there is no recursion: `files` reads `students` and
 *   `documents`, which read their own columns.
 *
 * - `audit_logs_insert_child`: the audited link (FIL-03 writes `file.download` for a document) is written in the
 *   parent's own request, so a parent may add an entry for the Society and Institution of the child the request names,
 *   and for no other. It is insert only: the audit log stays unreadable to a parent.
 *
 * Nothing else about a file widens: a parent has no insert, update or delete policy on either table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create policy documents_select_child on documents for select
      using (status = 1 and student_id = any (app_current_child_ids()))
  `.execute(db);
  await sql`
    create policy files_select_child on files for select
      using (
        (purpose = 3 and id in (
          select s.photo_file_id from students s where s.id = any (app_current_child_ids())
        ))
        or (purpose = 5 and id in (
          select d.file_id from documents d
          where d.status = 1 and d.student_id = any (app_current_child_ids())
        ))
      )
  `.execute(db);
  await sql`
    create policy audit_logs_insert_child on audit_logs for insert
      with check (
        exists (
          select 1 from students s
          where s.id = any (app_current_child_ids())
            and s.society_id = audit_logs.society_id and s.institution_id = audit_logs.institution_id
        )
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Production migrations only add (SDD 16.6): a parent opening their child's file relies on these.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to drop the parent file policies in production: parents rely on them',
    );
  }
  await sql`drop policy if exists audit_logs_insert_child on audit_logs`.execute(db);
  await sql`drop policy if exists files_select_child on files`.execute(db);
  await sql`drop policy if exists documents_select_child on documents`.execute(db);
}
