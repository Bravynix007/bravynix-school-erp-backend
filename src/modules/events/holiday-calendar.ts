import { Injectable } from '@nestjs/common';
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
    if (holidays.length === 0) return undefined;
    const limits = await this.events.classesOf(
      tx,
      holidays.map((holiday) => holiday.id),
    );
    for (const holiday of holidays) {
      const predefined = limits.get(holiday.id) ?? [];
      if (
        predefined.length === 0 ||
        (await this.classes.ofPredefined(tx, predefined)).has(classId)
      ) {
        return { eventId: holiday.id, title: holiday.title };
      }
    }
    return undefined;
  }
}
