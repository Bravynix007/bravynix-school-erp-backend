import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import type { Tx } from '../../platform/database/index.js';
import { ExamPeople } from '../exams/index.js';
import { StaffRepository, type StaffRow } from './staff.repository.js';

/** What People tells Exams (`ExamPeople`): whether a staff member can teach or invigilate a paper. */
@Injectable()
export class PeopleExamPeople extends ExamPeople {
  constructor(private readonly staff: StaffRepository) {
    super();
  }

  async requireSubjectTeacher(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    subjectId: string,
    field: string,
  ): Promise<void> {
    const teacher = await this.requireAtInstitution(tx, staffMemberId, institutionId, field);
    if (!(await this.staff.subjectIds(tx, teacher.id)).includes(subjectId)) {
      throw AppException.businessRule(ErrorCode.SUBJECT_NOT_TAUGHT);
    }
  }

  async requireInvigilator(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    field: string,
  ): Promise<void> {
    await this.requireAtInstitution(tx, staffMemberId, institutionId, field);
  }

  private async requireAtInstitution(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    field: string,
  ): Promise<StaffRow> {
    const member = await this.staff.find(tx, staffMemberId);
    if (!member) throw AppException.notFound();
    if (member.status === 0) throw AppException.referenceInactive(field);
    if (member.access_blocked_at !== null) throw AppException.businessRule(ErrorCode.STAFF_BLOCKED);
    if (member.home_institution_id !== institutionId) {
      throw AppException.businessRule(ErrorCode.STAFF_NOT_AT_INSTITUTION);
    }
    return member;
  }
}
