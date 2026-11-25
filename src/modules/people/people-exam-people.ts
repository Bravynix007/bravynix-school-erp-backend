import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { ExamPeople } from '../exams/index.js';
import { requireBookableStaff, requireBookableTeacher } from './staff-booking.js';
import { StaffRepository } from './staff.repository.js';

/** What People tells Exams (`ExamPeople`): whether a staff member can teach or invigilate a paper. */
@Injectable()
export class PeopleExamPeople extends ExamPeople {
  constructor(private readonly staff: StaffRepository) {
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
}
