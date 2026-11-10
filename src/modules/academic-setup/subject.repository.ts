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
  /** The Society's active subjects by name; with `ids`, only those of them. */
  active(tx: Tx, societyId: string, ids?: readonly string[]): Promise<SubjectRow[]> {
    const query = tx
      .selectFrom('subjects')
      .selectAll()
      .where('society_id', '=', societyId)
      .where('status', '=', 1);
    return (ids ? query.where('id', 'in', ids) : query)
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .execute();
  }

  /** The status of each of these subjects that the caller can see, by ID. */
  async statusesOf(tx: Tx, ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .selectFrom('subjects')
      .select(['id', 'status'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  /** The name of each of these subjects that the caller can see, by ID. */
  async namesOf(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .selectFrom('subjects')
      .select(['id', 'name'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((row) => [row.id, row.name]));
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
