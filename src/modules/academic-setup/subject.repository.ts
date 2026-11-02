import { Injectable } from '@nestjs/common';
import { sql, type Insertable, type Selectable, type Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { SubjectsTable } from './academic-setup.tables.js';

export type SubjectRow = Selectable<SubjectsTable>;
export type NewSubject = Insertable<SubjectsTable>;
export type SubjectChanges = Updateable<SubjectsTable>;

/** Queries on `subjects`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class SubjectRepository {
  /** The Society's active subjects by name. */
  active(tx: Tx, societyId: string): Promise<SubjectRow[]> {
    return tx
      .selectFrom('subjects')
      .selectAll()
      .where('society_id', '=', societyId)
      .where('status', '=', 1)
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .execute();
  }

  async find(tx: Tx, id: string, lock = false): Promise<SubjectRow | undefined> {
    const query = tx.selectFrom('subjects').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  insert(tx: Tx, values: NewSubject): Promise<SubjectRow> {
    return tx.insertInto('subjects').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: SubjectChanges): Promise<SubjectRow> {
    return tx
      .updateTable('subjects')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
