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

  /** The active sections of a class, in the order of the predefined sections; with `ids`, only those of them. */
  active(tx: Tx, classId: string, ids?: readonly string[]): Promise<SectionView[]> {
    const query = this.view(tx).where('s.class_id', '=', classId).where('s.status', '=', 1);
    return (ids ? query.where('s.id', 'in', ids) : query)
      .orderBy('p.display_order')
      .orderBy('s.id')
      .execute();
  }

  /** The section with its names. */
  viewOf(tx: Tx, id: string): Promise<SectionView> {
    return this.view(tx).where('s.id', '=', id).executeTakeFirstOrThrow();
  }

  /** The name of each of these sections and of its class, by section ID. */
  async namesOf(
    tx: Tx,
    ids: readonly string[],
  ): Promise<Map<string, { displayName: string; classId: string; className: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .selectFrom('sections as s')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['s.id', 's.display_name', 's.class_id', 'c.display_name as class_name'])
      .where('s.id', 'in', ids)
      .execute();
    return new Map(
      rows.map((row) => [
        row.id,
        { displayName: row.display_name, classId: row.class_id, className: row.class_name },
      ]),
    );
  }

  async find(tx: Tx, id: string, lock = false): Promise<SectionRow | undefined> {
    const query = tx.selectFrom('sections').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  /**
   * The section, held against deactivation until the transaction ends: whoever places a student in it keeps it open
   * (`for key share` waits for a deactivation under way, and a deactivation waits for it). The class is held first,
   * then the section, the order CLS-05 takes them in (DDD 13.3), so an add and a class deactivation cannot deadlock.
   */
  async keptOpen(tx: Tx, id: string): Promise<SectionRow | undefined> {
    const found = await tx
      .selectFrom('sections')
      .select('class_id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!found) return undefined;
    await tx
      .selectFrom('classes')
      .select('id')
      .where('id', '=', found.class_id)
      .forKeyShare()
      .execute();
    return tx
      .selectFrom('sections')
      .selectAll()
      .where('id', '=', id)
      .forKeyShare()
      .executeTakeFirst();
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
