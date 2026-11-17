import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { DiaryEntriesTable } from './diary.tables.js';

export type DiaryEntryRow = Selectable<DiaryEntriesTable>;
export type NewDiaryEntry = Insertable<DiaryEntriesTable>;
export type DiaryEntryChanges = Updateable<DiaryEntriesTable>;

/** Queries on `diary_entries`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class DiaryRepository {
  /** The active entries of a section on a date, in the order they were written. */
  list(tx: Tx, sectionId: string, date: string): Promise<DiaryEntryRow[]> {
    return tx
      .selectFrom('diary_entries')
      .selectAll()
      .where('section_id', '=', sectionId)
      .where('diary_date', '=', date)
      .where('status', '=', 1)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  find(tx: Tx, id: string, lock = false): Promise<DiaryEntryRow | undefined> {
    const query = tx.selectFrom('diary_entries').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  insert(tx: Tx, values: NewDiaryEntry): Promise<DiaryEntryRow> {
    return tx.insertInto('diary_entries').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: DiaryEntryChanges): Promise<DiaryEntryRow> {
    return tx
      .updateTable('diary_entries')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
