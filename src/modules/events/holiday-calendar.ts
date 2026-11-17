import { Injectable } from '@nestjs/common';
import { eachDay } from '../../common/time/calendar-days.js';
import type { Tx } from '../../platform/database/index.js';
import { ClassDirectory } from '../academic-setup/index.js';
import { EventRepository } from './event.repository.js';

/** A holiday that keeps a class at home on a day. */
export interface ClassHoliday {
  eventId: string;
  title: string;
}

/**
 * What Events tells other modules about holidays (PRD 7.12): whether a class has the day off. A holiday for students
 * covers a class when it names no class, or when the class is made from one of the predefined classes it names
 * ("Holiday up to 8th Grade"). The events stay private to this module (SDD 9.3 rule 1). It reads under the caller's
 * row-level security, in the caller's transaction.
 */
@Injectable()
export class HolidayCalendar {
  constructor(
    private readonly events: EventRepository,
    private readonly classes: ClassDirectory,
  ) {}

  /** The holiday that covers this class of the Institution on the date, the earliest one, or `undefined` for a school day. */
  async forClass(
    tx: Tx,
    institutionId: string,
    classId: string,
    date: string,
  ): Promise<ClassHoliday | undefined> {
    const holidays = await this.events.holidaysForStudentsOn(tx, institutionId, date);
    return (await this.coveringClass(tx, holidays, classId))[0];
  }

  /**
   * The title of the holiday that keeps this class of the Institution at home on each day from `from` to `to` that has
   * one (the earliest holiday of a day, as `forClass` answers), by date.
   */
  async between(
    tx: Tx,
    institutionId: string,
    classId: string,
    from: string,
    to: string,
  ): Promise<ReadonlyMap<string, string>> {
    const holidays = await this.events.holidaysForStudentsBetween(tx, institutionId, from, to);
    const days = new Map<string, string>();
    for (const holiday of await this.coveringClass(tx, holidays, classId)) {
      const row = holidays.find((candidate) => candidate.id === holiday.eventId)!;
      for (const day of eachDay(
        row.start_date > from ? row.start_date : from,
        row.end_date < to ? row.end_date : to,
      )) {
        if (!days.has(day)) days.set(day, holiday.title);
      }
    }
    return days;
  }

  /** The holidays that cover the class, in the order given. */
  private async coveringClass(
    tx: Tx,
    holidays: readonly { id: string; title: string }[],
    classId: string,
  ): Promise<ClassHoliday[]> {
    if (holidays.length === 0) return [];
    const limits = await this.events.classesOf(
      tx,
      holidays.map((holiday) => holiday.id),
    );
    const covering: ClassHoliday[] = [];
    for (const holiday of holidays) {
      const predefined = limits.get(holiday.id) ?? [];
      if (
        predefined.length === 0 ||
        (await this.classes.ofPredefined(tx, predefined)).has(classId)
      ) {
        covering.push({ eventId: holiday.id, title: holiday.title });
      }
    }
    return covering;
  }
}
