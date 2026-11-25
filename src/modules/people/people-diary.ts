import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { DiaryPeople, type DiaryReceiver } from '../diary/index.js';
import { AssignmentRepository } from './assignment.repository.js';
import { guardianReceiversOf } from './section-guardians.js';
import { StudentRepository } from './student.repository.js';

/**
 * What People tells Diary (`DiaryPeople`): what a teacher may write, where a child sits and who guards the children
 * of a section.
 */
@Injectable()
export class PeopleDiary extends DiaryPeople {
  constructor(
    private readonly assignments: AssignmentRepository,
    private readonly students: StudentRepository,
  ) {
    super();
  }

  mayWrite(
    tx: Tx,
    staffMemberId: string,
    academicYearId: string,
    sectionId: string,
    subjectId: string,
  ): Promise<boolean> {
    return this.assignments.mayWriteDiary(tx, staffMemberId, academicYearId, sectionId, subjectId);
  }

  diarySubjectIds(
    tx: Tx,
    staffMemberId: string,
    academicYearId: string,
    sectionId: string,
  ): Promise<string[] | null> {
    return this.assignments.diarySubjectIds(tx, staffMemberId, academicYearId, sectionId);
  }

  async currentSectionId(tx: Tx, studentId: string): Promise<string | undefined> {
    return (await this.students.openPlacement(tx, studentId))?.section_id;
  }

  receiversOf(tx: Tx, sectionId: string, date: string): Promise<DiaryReceiver[]> {
    return guardianReceiversOf(this.students, tx, sectionId, date);
  }
}
