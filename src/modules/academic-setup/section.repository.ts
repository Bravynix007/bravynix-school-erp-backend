import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { SectionsTable } from './academic-setup.tables.js';

export type SectionRow = Selectable<SectionsTable>;
export type NewSection = Insertable<SectionsTable>;
export type SectionChanges = Updateable<SectionsTable>;

/** A section with the name of the predefined section it is made from. */
export interface SectionView extends SectionRow {
  predefined_code: string;
  predefined_name: string;
}

/** Queries on `sections`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class SectionRepository {
  private view(tx: Tx) {
    return tx
      .selectFrom('sections as s')
      .innerJoin('predefined_sections as p', 'p.id', 's.predefined_section_id')
      .selectAll('s')
      .select(['p.code as predefined_code', 'p.name as predefined_name']);
  }

  /** The active sections of a class, in the order of the predefined sections. */
  active(tx: Tx, classId: string): Promise<SectionView[]> {
    return this.view(tx)
      .where('s.class_id', '=', classId)
      .where('s.status', '=', 1)
      .orderBy('p.display_order')
      .orderBy('s.id')
      .execute();
  }

  /** The section with its names. */
  viewOf(tx: Tx, id: string): Promise<SectionView> {
    return this.view(tx).where('s.id', '=', id).executeTakeFirstOrThrow();
  }

  async find(tx: Tx, id: string, lock = false): Promise<SectionRow | undefined> {
    const query = tx.selectFrom('sections').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  /** A class's active sections, locked for the class being deactivated. */
  lockedActive(tx: Tx, classId: string): Promise<SectionRow[]> {
    return tx
      .selectFrom('sections')
      .selectAll()
      .where('class_id', '=', classId)
      .where('status', '=', 1)
      .orderBy('id')
      .forUpdate()
      .execute();
  }

  insert(tx: Tx, values: NewSection): Promise<SectionRow> {
    return tx.insertInto('sections').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: SectionChanges): Promise<SectionRow> {
    return tx
      .updateTable('sections')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
