import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { authorIdsOf } from '../../common/http/author-stamps.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { newId } from '../../common/ids/ids.js';
import { AuditService } from '../../platform/audit/index.js';
import { DatabaseService, insertStamp, type Tx } from '../../platform/database/index.js';
import { PersonDirectory } from '../../platform/identity/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import { AchievementRepository } from './achievement.repository.js';
import type { CreateAchievementDto, ListAchievementsQueryDto } from './achievement.dto.js';
import {
  achievementResource,
  achievementsResource,
  type AchievementResource,
  type AchievementsResource,
} from './achievement.resource.js';
import { StaffRepository } from './staff.repository.js';
import { StudentClassroomService } from './student-classroom.service.js';
import { StudentContext } from './student-context.js';
import { StudentRepository } from './student.repository.js';

const AUDIT_ENTITY = 'student_achievement';

/**
 * ACH-01 to ACH-03 (API design 9.6, PRD 7.6): the stars given to a student. An Owner or an Admin of the child's
 * Institution gives and removes any; a Teacher or Staff member reads, gives and removes (their own only) for the
 * students of the sections they lead or teach this year, else 403 `NOT_ASSIGNED`. Stars follow the student's enrolment
 * for the year, so a new year starts a new count. A parent reads their own child's when parents have contexts.
 */
@Injectable()
export class AchievementService {
  constructor(
    private readonly database: DatabaseService,
    private readonly achievements: AchievementRepository,
    private readonly context: StudentContext,
    private readonly students: StudentRepository,
    private readonly classroom: StudentClassroomService,
    private readonly staff: StaffRepository,
    private readonly scope: ScopeService,
    private readonly people: PersonDirectory,
    private readonly audit: AuditService,
  ) {}

  /** ACH-01: the stars earned, by tier, and the stars, newest first; one year's with `academicYearId`. */
  async list(
    principal: Principal,
    studentId: string,
    query: ListAchievementsQueryDto,
  ): Promise<AchievementsResource> {
    const context = await this.context.of(principal, studentId);
    const rows = await this.database.transaction(context.tenant, async (tx) => {
      if (principal.roleCode === RoleCode.TeacherStaff) {
        const student = await this.students.find(tx, studentId);
        if (!student) throw AppException.notFound();
        await this.classroom.ownPlacement(tx, principal, context.institutionId, student);
      }
      return this.achievements.ofStudent(tx, studentId, query.academicYearId);
    });
    return achievementsResource(rows, await this.people.describe(authorIdsOf(rows)));
  }

  /**
   * ACH-02: gives a star to an active student who has an open placement (422 `NO_CURRENT_PLACEMENT` otherwise; a
   * teacher is 403 `NOT_ASSIGNED` for one that is not in their own section). The star is tied to the enrolment of the
   * current placement and to the staff record of the caller, none for an Owner.
   */
  async add(
    principal: Principal,
    studentId: string,
    body: CreateAchievementDto,
  ): Promise<AchievementResource> {
    const context = await this.context.of(principal, studentId);
    const created = await this.database.transaction(context.tenant, async (tx) => {
      const student = await this.context.lockedActive(tx, studentId);
      const open = await this.currentPlacement(tx, studentId);
      const placed =
        principal.roleCode === RoleCode.TeacherStaff
          ? await this.classroom.requireOwnSection(tx, principal, context.institutionId, open)
          : open;
      const by =
        principal.roleCode === RoleCode.SocietyOwner
          ? undefined
          : await this.staff.activeOfUser(tx, principal.personId);
      const row = await this.achievements.insert(tx, {
        id: newId(),
        society_id: student.society_id,
        institution_id: student.institution_id,
        academic_year_id: placed.academic_year_id,
        student_enrolment_id: placed.enrolment_id,
        tier: body.tier,
        description: body.description,
        awarded_by_staff_member_id: by?.id ?? null,
        ...insertStamp(principal.personId),
      });
      await this.audit.record(tx, {
        action: 'achievement.created',
        institutionId: row.institution_id,
        entityType: AUDIT_ENTITY,
        entityId: row.id,
        after: { studentId, academicYearId: row.academic_year_id, tier: row.tier },
      });
      return { ...row, student_id: studentId };
    });
    return achievementResource(created, await this.people.describe(authorIdsOf([created])));
  }

  /**
   * ACH-03: removes a star (`status` 0; the row stays). A teacher removes only a star they gave (403 `FORBIDDEN` for
   * another's). 404 for a star that does not exist, is already removed or is at an Institution the caller does not
   * reach.
   */
  async remove(principal: Principal, id: string): Promise<{ id: string; status: 0 }> {
    const { tenant } = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(tenant, (tx) => this.achievements.find(tx, id));
    if (!found) throw AppException.notFound();
    const context = await this.scope.requireInstitution(principal, found.institution_id);
    await this.database.transaction(context.tenant, async (tx) => {
      const current = await this.achievements.find(tx, id, true);
      if (!current || current.status === 0) throw AppException.notFound();
      if (
        principal.roleCode === RoleCode.TeacherStaff &&
        current.created_by !== principal.personId
      ) {
        throw AppException.forbidden();
      }
      await this.achievements.remove(tx, id, principal.personId);
      await this.audit.record(tx, {
        action: 'achievement.removed',
        institutionId: current.institution_id,
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: { studentId: current.student_id, tier: current.tier, status: 1 },
        after: { status: 0 },
      });
    });
    return { id, status: 0 };
  }

  private async currentPlacement(tx: Tx, studentId: string) {
    const placed = await this.students.openPlacement(tx, studentId);
    if (!placed) throw AppException.businessRule(ErrorCode.NO_CURRENT_PLACEMENT);
    return placed;
  }
}
