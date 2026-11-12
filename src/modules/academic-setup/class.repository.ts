import { Injectable } from '@nestjs/common';
import { sql, type Insertable, type Selectable, type Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { ClassesTable } from './academic-setup.tables.js';

export type ClassRow = Selectable<ClassesTable>;
export type NewClass = Insertable<ClassesTable>;
export type ClassChanges = Updateable<ClassesTable>;

/** A class with the names it is shown with and the number of its active sections. */
export interface ClassView extends ClassRow {
  predefined_code: string;
  predefined_name: string;
  category_code: string;
  category_name: string;
  section_count: number;
}

/** Queries on `classes`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class ClassRepository {
  /** `sectionIds` limits the section count to those sections: a teacher's own. */
  private view(tx: Tx, sectionIds?: readonly string[]) {
    const own = sectionIds ? sql` and s.id = any(${sql.val(sectionIds)}::uuid[])` : sql``;
    return tx
      .selectFrom('classes as c')
      .innerJoin('predefined_classes as p', 'p.id', 'c.predefined_class_id')
      .innerJoin('class_categories as g', 'g.id', 'c.class_category_id')
      .selectAll('c')
      .select([
        'p.code as predefined_code',
        'p.name as predefined_name',
        'g.code as category_code',
        'g.name as category_name',
        sql<number>`(select count(*)::int from sections s where s.class_id = c.id and s.status = 1${own})`.as(
          'section_count',
        ),
      ]);
  }

  /**
   * The active classes in the order of the lists: category, predefined class, then stream. With `sectionIds`, only
   * the classes that have one of those active sections, counting only those (a teacher's own classes).
   */
  active(tx: Tx, institutionId: string, sectionIds?: readonly string[]): Promise<ClassView[]> {
    const query = this.view(tx, sectionIds)
      .where('c.institution_id', '=', institutionId)
      .where('c.status', '=', 1);
    return (
      sectionIds
        ? query.where('c.id', 'in', (eb) =>
            eb
              .selectFrom('sections as o')
              .select('o.class_id')
              .where('o.status', '=', 1)
              .where('o.id', 'in', sectionIds),
          )
        : query
    )
      .orderBy('g.display_order')
      .orderBy('p.display_order')
      .orderBy(sql`lower(c.stream_name)`, (order) => order.asc().nullsFirst())
      .orderBy('c.id')
      .execute();
  }

  /** One class with its names; `lock` locks the class row for the change. */
  async find(tx: Tx, id: string, lock = false): Promise<ClassRow | undefined> {
    const query = tx.selectFrom('classes').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  /**
   * Whether the class is the last of its Institution: no active class of the Institution comes after it in the order
   * of the predefined classes (the order of the lists), with the Institution it belongs to. `undefined` for a class the
   * caller cannot see.
   */
  async isLast(
    tx: Tx,
    id: string,
  ): Promise<{ institutionId: string; isLast: boolean } | undefined> {
    const row = await tx
      .selectFrom('classes as c')
      .innerJoin('predefined_classes as p', 'p.id', 'c.predefined_class_id')
      .select((eb) =>
        eb
          .not(
            eb.exists(
              eb
                .selectFrom('classes as later')
                .innerJoin('predefined_classes as q', 'q.id', 'later.predefined_class_id')
                .select('later.id')
                .whereRef('later.institution_id', '=', 'c.institution_id')
                .where('later.status', '=', 1)
                .whereRef('q.display_order', '>', 'p.display_order'),
            ),
          )
          .as('is_last'),
      )
      .select('c.institution_id')
      .where('c.id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { institutionId: row.institution_id, isLast: Boolean(row.is_last) };
  }

  /** The classes with these IDs, with their names, in the order of the lists. */
  views(tx: Tx, ids: readonly string[]): Promise<ClassView[]> {
    return this.view(tx)
      .where('c.id', 'in', ids)
      .orderBy('g.display_order')
      .orderBy('p.display_order')
      .orderBy(sql`lower(c.stream_name)`, (order) => order.asc().nullsFirst())
      .orderBy('c.id')
      .execute();
  }

  /** The categories the Institution offers, as a set of IDs. */
  async offeredCategories(tx: Tx, institutionId: string): Promise<Set<string>> {
    const rows = await tx
      .selectFrom('institution_class_categories')
      .select('class_category_id')
      .where('institution_id', '=', institutionId)
      .execute();
    return new Set(rows.map((row) => row.class_category_id));
  }

  insert(tx: Tx, values: NewClass): Promise<ClassRow> {
    return tx.insertInto('classes').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: ClassChanges): Promise<ClassRow> {
    return tx
      .updateTable('classes')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
