import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { ExamPapersTable } from './exams.tables.js';

export type ExamPaperRow = Selectable<ExamPapersTable>;
export type NewExamPaper = Insertable<ExamPapersTable>;
export type ExamPaperChanges = Updateable<ExamPapersTable>;

/** Queries on `exam_papers`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class ExamPaperRepository {
  /** The active papers of an exam, in the order they are sat: by day, start and then section. */
  ofExam(tx: Tx, examId: string, sectionId?: string): Promise<ExamPaperRow[]> {
    let query = tx
      .selectFrom('exam_papers')
      .selectAll()
      .where('exam_id', '=', examId)
      .where('status', '=', 1);
    if (sectionId !== undefined) query = query.where('section_id', '=', sectionId);
    return query.orderBy('exam_date').orderBy('start_time').orderBy('section_id').execute();
  }

  find(tx: Tx, id: string, lock = false): Promise<ExamPaperRow | undefined> {
    const query = tx.selectFrom('exam_papers').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  /** Whether an active paper of the exam falls on a day outside `startDate` to `endDate`. */
  async anyOutside(tx: Tx, examId: string, startDate: string, endDate: string): Promise<boolean> {
    const found = await tx
      .selectFrom('exam_papers')
      .select('id')
      .where('exam_id', '=', examId)
      .where('status', '=', 1)
      .where((clause) =>
        clause.or([clause('exam_date', '<', startDate), clause('exam_date', '>', endDate)]),
      )
      .limit(1)
      .executeTakeFirst();
    return found !== undefined;
  }

  insert(tx: Tx, values: NewExamPaper): Promise<ExamPaperRow> {
    return tx.insertInto('exam_papers').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: ExamPaperChanges): Promise<ExamPaperRow> {
    return tx
      .updateTable('exam_papers')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
