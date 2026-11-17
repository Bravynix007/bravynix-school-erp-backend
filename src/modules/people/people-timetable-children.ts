import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { TimetableChildren } from '../timetable/index.js';
import { StudentRepository } from './student.repository.js';

/** What People tells Timetable (`TimetableChildren`): the section a child sits in now. */
@Injectable()
export class PeopleTimetableChildren extends TimetableChildren {
  constructor(private readonly students: StudentRepository) {
    super();
  }

  async currentSectionId(tx: Tx, studentId: string): Promise<string | undefined> {
    return (await this.students.openPlacement(tx, studentId))?.section_id;
  }
}
