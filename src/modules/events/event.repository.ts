import { Injectable } from '@nestjs/common';
import { sql, type Insertable, type Selectable, type Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { EventsTable } from './events.tables.js';

export type EventRow = Selectable<EventsTable>;
export type NewEvent = Insertable<EventsTable>;
export type EventChanges = Updateable<EventsTable>;

/** What EVT-01 asks of the rows the caller can see. */
export interface EventFilter {
  /** Events that have a day in `from` to `to`, both included. */
  from: string;
  to: string;
  holidaysOnly: boolean;
  audiences: readonly number[];
  /** Leaves out the holidays that are not for students: what a parent's calendar shows. */
  forStudents?: boolean;
}

/** Queries on `events` and `event_holiday_classes`; each runs in the caller's transaction, under row-level security. */
@Injectable()
export class EventRepository {
  /** The active events with a day in the span, earliest first, for the audiences given. */
  list(tx: Tx, filter: EventFilter): Promise<EventRow[]> {
    if (filter.audiences.length === 0) return Promise.resolve([]);
    return tx
      .selectFrom('events')
      .selectAll()
      .where('status', '=', 1)
      .where('start_date', '<=', filter.to)
      .where('end_date', '>=', filter.from)
      .where('audience', 'in', filter.audiences)
      .$if(filter.holidaysOnly, (query) => query.where('is_holiday', '=', true))
      .$if(filter.forStudents === true, (query) =>
        query.where((eb) =>
          eb.or([eb('is_holiday', '=', false), eb('holiday_for_students', '=', true)]),
        ),
      )
      .orderBy('start_date')
      .orderBy('end_date')
      .orderBy(sql`lower(title)`)
      .orderBy('id')
      .execute();
  }

  /**
   * The active holidays for students with a day between `from` and `to` (a single day when they are the same) in the
   * Institution: the Society's and the Institution's own, earliest first.
   */
  holidaysForStudentsBetween(
    tx: Tx,
    institutionId: string,
    from: string,
    to: string,
  ): Promise<EventRow[]> {
    return tx
      .selectFrom('events')
      .selectAll()
      .where('status', '=', 1)
      .where('is_holiday', '=', true)
      .where('holiday_for_students', '=', true)
      .where('start_date', '<=', to)
      .where('end_date', '>=', from)
      .where((eb) =>
        eb.or([eb('institution_id', 'is', null), eb('institution_id', '=', institutionId)]),
      )
      .orderBy('start_date')
      .orderBy(sql`lower(title)`)
      .orderBy('id')
      .execute();
  }

  async find(tx: Tx, id: string, lock = false): Promise<EventRow | undefined> {
    const query = tx.selectFrom('events').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  insert(tx: Tx, values: NewEvent): Promise<EventRow> {
    return tx.insertInto('events').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: EventChanges): Promise<EventRow> {
    return tx
      .updateTable('events')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The predefined classes each of these holidays is limited to, by event; an event with none is for every class. */
  async classesOf(tx: Tx, eventIds: readonly string[]): Promise<Map<string, string[]>> {
    const classes = new Map<string, string[]>();
    if (eventIds.length === 0) return classes;
    const rows = await tx
      .selectFrom('event_holiday_classes')
      .select(['event_id', 'predefined_class_id'])
      .where('event_id', 'in', eventIds)
      .orderBy('predefined_class_id')
      .execute();
    for (const row of rows) {
      classes.set(row.event_id, [...(classes.get(row.event_id) ?? []), row.predefined_class_id]);
    }
    return classes;
  }

  /** Replaces the classes of an event with these: the set is hard-deleted and written again (DDD 9.8). */
  async replaceClasses(
    tx: Tx,
    eventId: string,
    societyId: string,
    classIds: readonly string[],
  ): Promise<void> {
    await tx.deleteFrom('event_holiday_classes').where('event_id', '=', eventId).execute();
    if (classIds.length === 0) return;
    await tx
      .insertInto('event_holiday_classes')
      .values(
        classIds.map((classId) => ({
          event_id: eventId,
          predefined_class_id: classId,
          society_id: societyId,
        })),
      )
      .execute();
  }
}
