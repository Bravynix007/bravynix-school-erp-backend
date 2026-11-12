import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { StudentAchievementsTable } from './people.tables.js';

/** A star with the student it belongs to, read through its enrolment. */
export type AchievementRow = Selectable<StudentAchievementsTable> & { student_id: string };
export type NewAchievement = Insertable<StudentAchievementsTable>;

/** Queries on `student_achievements` (DDD 9.6); every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class AchievementRepository {
  /** The active stars of a student, newest first; `academicYearId` keeps one year's. */
  ofStudent(tx: Tx, studentId: string, academicYearId?: string): Promise<AchievementRow[]> {
    let query = tx
      .selectFrom('student_achievements as a')
      .innerJoin('student_enrolments as e', 'e.id', 'a.student_enrolment_id')
      .selectAll('a')
      .select('e.student_id')
      .where('e.student_id', '=', studentId)
      .where('a.status', '=', 1);
    if (academicYearId !== undefined)
      query = query.where('a.academic_year_id', '=', academicYearId);
    return query.orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').execute();
  }

  /** The star with its student; `lock` takes the star's own row for the change and leaves the enrolment alone. */
  async find(tx: Tx, id: string, lock = false): Promise<AchievementRow | undefined> {
    const own = tx.selectFrom('student_achievements').selectAll().where('id', '=', id);
    const row = await (lock ? own.forUpdate() : own).executeTakeFirst();
    if (!row) return undefined;
    const enrolment = await tx
      .selectFrom('student_enrolments')
      .select('student_id')
      .where('id', '=', row.student_enrolment_id)
      .executeTakeFirstOrThrow();
    return { ...row, student_id: enrolment.student_id };
  }

  async insert(tx: Tx, values: NewAchievement): Promise<Selectable<StudentAchievementsTable>> {
    return tx
      .insertInto('student_achievements')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async remove(tx: Tx, id: string, by: string): Promise<void> {
    await tx
      .updateTable('student_achievements')
      .set({ status: 0, updated_by: by })
      .where('id', '=', id)
      .execute();
  }
}
