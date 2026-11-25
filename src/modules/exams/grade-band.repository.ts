import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { GradeBandsTable } from './exams.tables.js';

export type GradeBandRow = Selectable<GradeBandsTable>;
export type NewGradeBand = Insertable<GradeBandsTable>;
export type GradeBandChanges = Updateable<GradeBandsTable>;

/** Queries on `grade_bands`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class GradeBandRepository {
  /** The active bands of an Institution, the highest first, as a report card lists them. */
  active(tx: Tx, institutionId: string): Promise<GradeBandRow[]> {
    return tx
      .selectFrom('grade_bands')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('status', '=', 1)
      .orderBy('min_percentage', 'desc')
      .execute();
  }

  find(tx: Tx, id: string, lock = false): Promise<GradeBandRow | undefined> {
    const query = tx.selectFrom('grade_bands').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  insert(tx: Tx, values: NewGradeBand): Promise<GradeBandRow> {
    return tx.insertInto('grade_bands').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: GradeBandChanges): Promise<GradeBandRow> {
    return tx
      .updateTable('grade_bands')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
