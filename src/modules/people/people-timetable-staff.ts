import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import type { Tx } from '../../platform/database/index.js';
import { TimetableStaff } from '../timetable/index.js';
import { StaffRepository } from './staff.repository.js';

/** What People tells Timetable (`TimetableStaff`): whether a teacher can take a lesson. */
@Injectable()
export class PeopleTimetableStaff extends TimetableStaff {
  constructor(private readonly staff: StaffRepository) {
    super();
  }

  async requireTeacher(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    subjectId: string,
  ): Promise<void> {
    const teacher = await this.staff.find(tx, staffMemberId);
    if (!teacher) throw AppException.notFound();
    if (teacher.status === 0) throw AppException.referenceInactive('staffMemberId');
    if (teacher.access_blocked_at !== null)
      throw AppException.businessRule(ErrorCode.STAFF_BLOCKED);
    if (teacher.home_institution_id !== institutionId) {
      throw AppException.businessRule(ErrorCode.STAFF_NOT_AT_INSTITUTION);
    }
    if (!(await this.staff.subjectIds(tx, teacher.id)).includes(subjectId)) {
      throw AppException.businessRule(ErrorCode.SUBJECT_NOT_TAUGHT);
    }
  }
}
