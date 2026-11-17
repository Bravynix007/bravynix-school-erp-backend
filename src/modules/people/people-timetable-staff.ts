import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import type { Tx } from '../../platform/database/index.js';
import { TimetableStaff } from '../timetable/index.js';
import { StaffRepository, type StaffName } from './staff.repository.js';

const displayName = (name: StaffName): string =>
  [name.first_name, name.last_name].filter((part) => part !== null && part !== '').join(' ');

/** What People tells Timetable (`TimetableStaff`): whether a teacher can take a lesson, who the caller is, and names. */
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

  async ownRecord(
    tx: Tx,
    personId: string,
  ): Promise<{ staffMemberId: string; homeInstitutionId: string } | undefined> {
    const own = await this.staff.activeOfUser(tx, personId);
    return own && { staffMemberId: own.id, homeInstitutionId: own.home_institution_id };
  }

  async names(tx: Tx, staffMemberIds: readonly string[]): Promise<Map<string, string>> {
    return this.named(await this.staff.namesOf(tx, staffMemberIds));
  }

  async namesForParent(tx: Tx, staffMemberIds: readonly string[]): Promise<Map<string, string>> {
    return this.named(await this.staff.namesForParent(tx, staffMemberIds));
  }

  private named(found: ReadonlyMap<string, StaffName>): Map<string, string> {
    return new Map([...found].map(([id, name]) => [id, displayName(name)]));
  }
}
