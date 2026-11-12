import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { SectionStudents } from '../academic-setup/index.js';
import { StudentRepository } from './student.repository.js';

/** What People tells Academic setup about students (`SectionStudents`): how many sit in each section now. */
@Injectable()
export class PeopleSectionStudents extends SectionStudents {
  constructor(private readonly students: StudentRepository) {
    super();
  }

  async countsOf(tx: Tx, sectionIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return this.students.sectionCounts(tx, sectionIds);
  }
}
