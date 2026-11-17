import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { TimeSlotsTable } from './timetable.tables.js';

export type TimeSlotRow = Selectable<TimeSlotsTable>;
export type NewTimeSlot = Insertable<TimeSlotsTable>;
export type TimeSlotChanges = Updateable<TimeSlotsTable>;

/** Queries on `time_slots`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class TimeSlotRepository {
  /** The active periods of a year, earliest first. */
  active(tx: Tx, academicYearId: string): Promise<TimeSlotRow[]> {
    return tx
      .selectFrom('time_slots')
      .selectAll()
      .where('academic_year_id', '=', academicYearId)
      .where('status', '=', 1)
      .orderBy('start_time')
      .orderBy('period_no')
      .execute();
  }

  find(tx: Tx, id: string, lock = false): Promise<TimeSlotRow | undefined> {
    const query = tx.selectFrom('time_slots').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  insert(tx: Tx, values: NewTimeSlot): Promise<TimeSlotRow> {
    return tx.insertInto('time_slots').values(values).returningAll().executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: TimeSlotChanges): Promise<TimeSlotRow> {
    return tx
      .updateTable('time_slots')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
