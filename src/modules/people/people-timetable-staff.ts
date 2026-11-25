import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { TimetableStaff } from '../timetable/index.js';
import { requireBookableTeacher } from './staff-booking.js';
import { StaffRepository } from './staff.repository.js';

/** What People tells Timetable (`TimetableStaff`): whether a teacher can take a lesson. */
@Injectable()
export class PeopleTimetableStaff extends TimetableStaff {
  constructor(private readonly staff: StaffRepository) {
    super();
  }

  requireTeacher(
    tx: Tx,
    staffMemberId: string,
    institutionId: string,
    subjectId: string,
  ): Promise<void> {
    return requireBookableTeacher(
      this.staff,
      tx,
      staffMemberId,
      institutionId,
      subjectId,
      'staffMemberId',
    );
  }
}
