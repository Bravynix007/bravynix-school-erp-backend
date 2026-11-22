import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { StaffDirectory } from '../academic-setup/index.js';
import { StaffRepository, type StaffName } from './staff.repository.js';

const displayName = (name: StaffName): string =>
  [name.first_name, name.last_name].filter((part) => part !== null && part !== '').join(' ');

/** What People tells Attendance, Timetable and Diary (`StaffDirectory`): which staff member the caller is, and names. */
@Injectable()
export class PeopleStaffDirectory extends StaffDirectory {
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
