import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { ExamsTable } from './exams.tables.js';

export type ExamRow = Selectable<ExamsTable>;
export type NewExam = Insertable<ExamsTable>;
export type ExamChanges = Updateable<ExamsTable>;

/** Queries on `exams`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class ExamRepository {
  /** The active exams of a year, the earliest first. */
  active(tx: Tx, academicYearId: string): Promise<ExamRow[]> {
    return tx
      .selectFrom('exams')
      .selectAll()
      .where('academic_year_id', '=', academicYearId)
      .where('status', '=', 1)
      .orderBy('start_date')
      .orderBy('name')
      .execute();
  }

  find(tx: Tx, id: string, lock = false): Promise<ExamRow | undefined> {
    const query = tx.selectFrom('exams').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  insert(tx: Tx, values: NewExam): Promise<ExamRow> {
    return tx.insertInto('exams').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: ExamChanges): Promise<ExamRow> {
    return tx
      .updateTable('exams')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
