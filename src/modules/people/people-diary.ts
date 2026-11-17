import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { DiaryPeople, type DiaryReceiver } from '../diary/index.js';
import { AssignmentRepository } from './assignment.repository.js';
import { StaffRepository, type StaffName } from './staff.repository.js';
import { StudentRepository } from './student.repository.js';

const displayName = (name: StaffName): string =>
  [name.first_name, name.last_name].filter((part) => part !== null && part !== '').join(' ');

/**
 * What People tells Diary (`DiaryPeople`): who the writer is, what they may write, the teachers' names, where a child
 * sits and who guards the children of a section.
 */
@Injectable()
export class PeopleDiary extends DiaryPeople {
  constructor(
    private readonly staff: StaffRepository,
    private readonly assignments: AssignmentRepository,
    private readonly students: StudentRepository,
  ) {
    super();
  }

  async ownRecord(
    tx: Tx,
    personId: string,
  ): Promise<{ staffMemberId: string; homeInstitutionId: string } | undefined> {
    const own = await this.staff.activeOfUser(tx, personId);
    return own && { staffMemberId: own.id, homeInstitutionId: own.home_institution_id };
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

  async names(tx: Tx, staffMemberIds: readonly string[]): Promise<Map<string, string>> {
    return this.named(await this.staff.namesOf(tx, staffMemberIds));
  }

  async namesForParent(tx: Tx, staffMemberIds: readonly string[]): Promise<Map<string, string>> {
    return this.named(await this.staff.namesForParent(tx, staffMemberIds));
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

  private named(found: ReadonlyMap<string, StaffName>): Map<string, string> {
    return new Map([...found].map(([id, name]) => [id, displayName(name)]));
  }
}
