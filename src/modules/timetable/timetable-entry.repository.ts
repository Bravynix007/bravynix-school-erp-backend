import { Injectable } from '@nestjs/common';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Tx } from '../../platform/database/index.js';
import type { TimetableEntriesTable } from './timetable.tables.js';

export type TimetableEntryRow = Selectable<TimetableEntriesTable>;
export type NewTimetableEntry = Insertable<TimetableEntriesTable>;
export type TimetableEntryChanges = Updateable<TimetableEntriesTable>;

/** An entry with the period it sits in. */
export interface TimetableEntryWithSlot extends TimetableEntryRow {
  period_no: number;
  label: string | null;
  start_time: string;
  end_time: string;
}

/** What to read: the entries of a year, of a section or of a teacher, or these IDs. */
export interface EntryFilter {
  academicYearId?: string;
  sectionId?: string;
  staffMemberId?: string;
  ids?: readonly string[];
}

/** Queries on `timetable_entries`; every one runs in the caller's transaction, under row-level security. */
@Injectable()
export class TimetableEntryRepository {
  /** The active entries that match, by day and then by when the period starts. */
  withSlots(tx: Tx, filter: EntryFilter): Promise<TimetableEntryWithSlot[]> {
    let query = tx
      .selectFrom('timetable_entries as e')
      .innerJoin('time_slots as t', 't.id', 'e.time_slot_id')
      .selectAll('e')
      .select(['t.period_no', 't.label', 't.start_time', 't.end_time'])
      .where('e.status', '=', 1);
    if (filter.academicYearId)
      query = query.where('e.academic_year_id', '=', filter.academicYearId);
    if (filter.sectionId) query = query.where('e.section_id', '=', filter.sectionId);
    if (filter.staffMemberId) query = query.where('e.staff_member_id', '=', filter.staffMemberId);
    if (filter.ids) query = query.where('e.id', 'in', filter.ids);
    return query.orderBy('e.day_of_week').orderBy('t.start_time').orderBy('e.id').execute();
  }

  find(tx: Tx, id: string, lock = false): Promise<TimetableEntryRow | undefined> {
    const query = tx.selectFrom('timetable_entries').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  /** The active entry of the section in this day and period, other than `exceptId`. */
  sectionTaken(
    tx: Tx,
    sectionId: string,
    day: number,
    timeSlotId: string,
    exceptId?: string,
  ): Promise<TimetableEntryRow | undefined> {
    const query = tx
      .selectFrom('timetable_entries')
      .selectAll()
      .where('section_id', '=', sectionId)
      .where('day_of_week', '=', day)
      .where('time_slot_id', '=', timeSlotId)
      .where('status', '=', 1);
    return (exceptId ? query.where('id', '!=', exceptId) : query).executeTakeFirst();
  }

  /** The active entry of the teacher in this day and period, other than `exceptId`. */
  teacherBooked(
    tx: Tx,
    staffMemberId: string,
    day: number,
    timeSlotId: string,
    exceptId?: string,
  ): Promise<TimetableEntryRow | undefined> {
    const query = tx
      .selectFrom('timetable_entries')
      .selectAll()
      .where('staff_member_id', '=', staffMemberId)
      .where('day_of_week', '=', day)
      .where('time_slot_id', '=', timeSlotId)
      .where('status', '=', 1);
    return (exceptId ? query.where('id', '!=', exceptId) : query).executeTakeFirst();
  }

  /** Whether an active entry sits in this period. */
  async usesSlot(tx: Tx, timeSlotId: string): Promise<boolean> {
    const row = await tx
      .selectFrom('timetable_entries')
      .select('id')
      .where('time_slot_id', '=', timeSlotId)
      .where('status', '=', 1)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  insert(tx: Tx, values: NewTimetableEntry): Promise<TimetableEntryRow> {
    return tx
      .insertInto('timetable_entries')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  update(tx: Tx, id: string, changes: TimetableEntryChanges): Promise<TimetableEntryRow> {
    return tx
      .updateTable('timetable_entries')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
