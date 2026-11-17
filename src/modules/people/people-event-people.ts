import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import { GrantDirectory } from '../../platform/identity/index.js';
import { ClassDirectory } from '../academic-setup/index.js';
import { EventPeople } from '../events/index.js';
import { StaffRepository } from './staff.repository.js';
import { StudentRepository } from './student.repository.js';

/** What People tells Events (`EventPeople`): the staff and the parents of an audience. */
@Injectable()
export class PeopleEventPeople extends EventPeople {
  constructor(
    private readonly grants: GrantDirectory,
    private readonly staff: StaffRepository,
    private readonly students: StudentRepository,
    private readonly classes: ClassDirectory,
  ) {
    super();
  }

  async staffUserIds(
    tx: Tx,
    societyId: string,
    institutionId: string | null,
  ): Promise<readonly string[]> {
    const [owners, admins, staff] = await Promise.all([
      this.grants.societyOwners(societyId),
      this.grants.adminUserIds(societyId, institutionId),
      this.staff.activeUserIds(tx, institutionId),
    ]);
    return [...new Set([...owners.map((owner) => owner.id), ...admins, ...staff])];
  }

  async parentUserIds(
    tx: Tx,
    institutionId: string | null,
    predefinedClassIds: readonly string[],
  ): Promise<readonly string[]> {
    const classIds =
      predefinedClassIds.length === 0
        ? null
        : await this.classes.ofPredefined(tx, predefinedClassIds);
    return this.students.guardianUserIds(tx, institutionId, classIds);
  }
}
