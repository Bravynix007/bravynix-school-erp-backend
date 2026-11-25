import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { ExamPeople, type ExamReceiver } from '../exams/index.js';
import { requireBookableStaff, requireBookableTeacher } from './staff-booking.js';
import { guardianReceiversOf } from './section-guardians.js';
import { StaffRepository } from './staff.repository.js';
import { StudentRepository } from './student.repository.js';

/** What People tells Exams (`ExamPeople`): whether a staff member can teach or invigilate a paper. */
@Injectable()
export class PeopleExamPeople extends ExamPeople {
  constructor(
    private readonly staff: StaffRepository,
    private readonly students: StudentRepository,
  ) {
    super();
  }

  requireSubjectTeacher(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    subjectId: string,
    field: string,
  ): Promise<void> {
    return requireBookableTeacher(this.staff, tx, staffMemberId, institutionId, subjectId, field);
  }

  async requireInvigilator(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    field: string,
  ): Promise<void> {
    await requireBookableStaff(this.staff, tx, staffMemberId, institutionId, field);
  }

  guardianReceivers(tx: Tx, sectionId: string, date: string): Promise<ExamReceiver[]> {
    return guardianReceiversOf(this.students, tx, sectionId, date);
  }

  staffUserIds(tx: Tx, staffMemberIds: readonly string[]): Promise<readonly string[]> {
    return this.staff.userIdsOf(tx, staffMemberIds);
  }
}
