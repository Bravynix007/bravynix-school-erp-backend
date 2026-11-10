import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database/index.js';
import {
  AcademicYearDirectory,
  TeachingStaff,
  type ClassTeacherRef,
} from '../academic-setup/index.js';
import { AssignmentRepository } from './assignment.repository.js';
import { StaffRepository } from './staff.repository.js';

/**
 * What People tells Academic setup about teachers (`TeachingStaff`): the sections, years and subjects a teacher
 * handles, and who leads each section. The assignments are kept only at the teacher's home Institution, so a teacher
 * has none at an extra Institution, and the answer there is empty (PRD 4, decision 11).
 */
@Injectable()
export class PeopleTeachingStaff extends TeachingStaff {
  constructor(
    private readonly staff: StaffRepository,
    private readonly assignments: AssignmentRepository,
    private readonly years: AcademicYearDirectory,
  ) {
    super();
  }

  async ownSectionIds(
    tx: Tx,
    personId: string,
    institutionId: string,
  ): Promise<ReadonlySet<string>> {
    const record = await this.staff.activeOfUser(tx, personId);
    const year = await this.years.currentId(tx, institutionId);
    if (!record || year === null) return new Set();
    return new Set(await this.assignments.activeSectionIds(tx, record.id, year));
  }

  async ownYearIds(tx: Tx, personId: string, institutionId: string): Promise<ReadonlySet<string>> {
    const record = await this.staff.activeOfUser(tx, personId);
    if (!record) return new Set();
    return new Set(await this.assignments.activeYearIds(tx, record.id, institutionId));
  }

  async ownSubjectIds(tx: Tx, personId: string): Promise<ReadonlySet<string>> {
    const record = await this.staff.activeOfUser(tx, personId);
    return record ? new Set(await this.staff.subjectIds(tx, record.id)) : new Set();
  }

  async classTeachers(
    tx: Tx,
    institutionId: string,
    sectionIds: readonly string[],
  ): Promise<ReadonlyMap<string, ClassTeacherRef>> {
    const year = await this.years.currentId(tx, institutionId);
    if (year === null || sectionIds.length === 0) return new Map();
    const rows = await this.assignments.classTeachersOf(tx, year, sectionIds);
    return new Map(
      rows.map((row) => [
        row.section_id,
        { staffMemberId: row.staff_member_id, firstName: row.first_name, lastName: row.last_name },
      ]),
    );
  }
}
