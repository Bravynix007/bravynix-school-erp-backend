import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { SectionRoster, type MarkedStudent, type RosterStudent } from '../attendance/index.js';
import { StudentRepository } from './student.repository.js';

/** What People tells Attendance (`SectionRoster`): who sits in a section on a day, and who guards them. */
@Injectable()
export class PeopleSectionRoster extends SectionRoster {
  constructor(private readonly students: StudentRepository) {
    super();
  }

  on(tx: Tx, sectionId: string, date: string, placedBefore?: Date): Promise<RosterStudent[]> {
    return this.students.placedOn(tx, sectionId, date, placedBefore);
  }

  studentsOf(
    tx: Tx,
    studentEnrolmentIds: readonly string[],
  ): Promise<ReadonlyMap<string, MarkedStudent>> {
    return this.students.namedByEnrolment(tx, studentEnrolmentIds);
  }

  guardiansOf(
    tx: Tx,
    studentEnrolmentIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    return this.students.guardianUsersByEnrolment(tx, studentEnrolmentIds);
  }
}
