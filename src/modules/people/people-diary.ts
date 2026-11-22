import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { DiaryPeople, type DiaryReceiver } from '../diary/index.js';
import { AssignmentRepository } from './assignment.repository.js';
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

  async currentSectionId(tx: Tx, studentId: string): Promise<string | undefined> {
    return (await this.students.openPlacement(tx, studentId))?.section_id;
  }

  async receiversOf(tx: Tx, sectionId: string, date: string): Promise<DiaryReceiver[]> {
    const placed = await this.students.placedOn(tx, sectionId, date);
    const guardians = await this.students.guardianUsersByEnrolment(
      tx,
      placed.map((student) => student.studentEnrolmentId),
    );
    return placed.flatMap((student) =>
      (guardians.get(student.studentEnrolmentId) ?? []).map((userId) => ({
        userId,
        studentId: student.studentId,
      })),
    );
  }
}
