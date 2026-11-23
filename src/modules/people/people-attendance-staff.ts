import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { AttendanceStaff } from '../attendance/index.js';
import { StaffRepository } from './staff.repository.js';

/** What People tells Attendance (`AttendanceStaff`): which staff member the caller is, and where they are at home. */
@Injectable()
export class PeopleAttendanceStaff extends AttendanceStaff {
  constructor(private readonly staff: StaffRepository) {
    super();
  }

  async ownRecord(
    tx: Tx,
    personId: string,
  ): Promise<{ staffMemberId: string; homeInstitutionId: string } | undefined> {
    const own = await this.staff.activeOfUser(tx, personId);
    return own && { staffMemberId: own.id, homeInstitutionId: own.home_institution_id };
  }
}
