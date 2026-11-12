import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { DocumentsTable } from './people.tables.js';

export type DocumentRow = Selectable<DocumentsTable>;
export type NewDocument = Insertable<DocumentsTable>;

/** Queries on `documents` (DDD 9.6); every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class DocumentRepository {
  find(tx: Tx, id: string, lock = false): Promise<DocumentRow | undefined> {
    const query = tx.selectFrom('documents').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  /** The active documents of a staff member, newest first. */
  ofStaff(tx: Tx, staffMemberId: string): Promise<DocumentRow[]> {
    return tx
      .selectFrom('documents')
      .selectAll()
      .where('staff_member_id', '=', staffMemberId)
      .where('status', '=', 1)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  /** The active documents of a student, newest first. */
  ofStudent(tx: Tx, studentId: string): Promise<DocumentRow[]> {
    return tx
      .selectFrom('documents')
      .selectAll()
      .where('student_id', '=', studentId)
      .where('status', '=', 1)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  /** Is this file that of an active document of the person's own active staff record? (FIL-03 for a teacher) */
  async isOwnFile(tx: Tx, fileId: string, personId: string): Promise<boolean> {
    const row = await tx
      .selectFrom('documents as d')
      .innerJoin('staff_members as s', 's.id', 'd.staff_member_id')
      .select('d.id')
      .where('d.file_id', '=', fileId)
      .where('d.status', '=', 1)
      .where('s.user_id', '=', personId)
      .where('s.status', '=', 1)
      .executeTakeFirst();
    return row !== undefined;
  }

  insert(tx: Tx, values: NewDocument): Promise<DocumentRow> {
    return tx.insertInto('documents').values(values).returningAll().executeTakeFirstOrThrow();
  }

  async deactivate(tx: Tx, id: string, by: string): Promise<void> {
    await tx
      .updateTable('documents')
      .set({ status: 0, updated_by: by })
      .where('id', '=', id)
      .execute();
  }
}
