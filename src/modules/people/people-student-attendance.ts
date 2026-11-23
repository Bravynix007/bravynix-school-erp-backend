import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { AppException } from '../../common/http/app-exception.js';
import { DatabaseService, type Tx } from '../../platform/database/index.js';
import type { InstitutionContext } from '../../platform/tenancy/index.js';
import { StudentAttendanceAccess, type PlacementSpan } from '../attendance/index.js';
import { StudentClassroomService } from './student-classroom.service.js';
import { StudentContext } from './student-context.js';
import { StudentRepository } from './student.repository.js';

/** What People tells Attendance (`StudentAttendanceAccess`): who may read a student's calendar, and where they sat. */
@Injectable()
export class PeopleStudentAttendance extends StudentAttendanceAccess {
  constructor(
    private readonly database: DatabaseService,
    private readonly students: StudentRepository,
    private readonly context: StudentContext,
    private readonly classroom: StudentClassroomService,
  ) {
    super();
  }

  async contextOf(principal: Principal, studentId: string): Promise<InstitutionContext> {
    const context = await this.context.of(principal, studentId);
    if (principal.roleCode === RoleCode.TeacherStaff) {
      await this.database.transaction(context.tenant, async (tx) => {
        const row = await this.students.find(tx, studentId);
        if (!row) throw AppException.notFound();
        await this.classroom.ownPlacement(tx, principal, context.institutionId, row);
      });
    }
    return context;
  }

  placementsOf(tx: Tx, studentId: string, from: string, to: string): Promise<PlacementSpan[]> {
    return this.students.placementSpans(tx, studentId, from, to);
  }
}
