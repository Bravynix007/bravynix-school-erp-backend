import { Injectable } from '@nestjs/common';
import type { Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { StudentGuardiansTable } from './people.tables.js';
import type { GuardianRow } from './student.repository.js';

export type GuardianChanges = Updateable<StudentGuardiansTable>;

/** Queries on `student_guardians` for GDN-01 to GDN-04 (DDD 9.6); every one runs in the caller's transaction. */
@Injectable()
export class GuardianRepository {
  /** The guardian, active or not; `lock` holds the row for the change. */
  find(tx: Tx, id: string, lock = false): Promise<GuardianRow | undefined> {
    const query = tx.selectFrom('student_guardians').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  update(tx: Tx, id: string, changes: GuardianChanges): Promise<GuardianRow> {
    return tx
      .updateTable('student_guardians')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The primary guardian of the student, if any; GDN-02 and GDN-03 hand the place to another. */
  primaryOf(tx: Tx, studentId: string): Promise<GuardianRow | undefined> {
    return tx
      .selectFrom('student_guardians')
      .selectAll()
      .where('student_id', '=', studentId)
      .where('is_primary', '=', true)
      .where('status', '=', 1)
      .executeTakeFirst();
  }

  /** Is the person already an active guardian of the student, other than `exceptId`? */
  async isLinked(tx: Tx, studentId: string, userId: string, exceptId?: string): Promise<boolean> {
    let query = tx
      .selectFrom('student_guardians')
      .select('id')
      .where('student_id', '=', studentId)
      .where('user_id', '=', userId)
      .where('status', '=', 1);
    if (exceptId) query = query.where('id', '<>', exceptId);
    return (await query.executeTakeFirst()) !== undefined;
  }
}
