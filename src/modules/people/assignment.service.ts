import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { pageMeta, pageOffset } from '../../common/pagination/pagination.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../../platform/audit/index.js';
import {
  DatabaseService,
  duplicateOn,
  isDuplicateOn,
  type Tx,
} from '../../platform/database/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import {
  AcademicYearDirectory,
  SectionDirectory,
  SubjectDirectory,
} from '../academic-setup/index.js';
import type {
  CreateTeachingAssignmentDto,
  ListTeachingAssignmentsQueryDto,
  SetClassTeacherDto,
} from './assignment.dto.js';
import {
  AssignmentRepository,
  type ClassTeacherRow,
  type TeachingView,
} from './assignment.repository.js';
import {
  classTeacherResource,
  teachingResource,
  type ClassTeacherResource,
  type TeachingAssignmentResource,
} from './assignment.resource.js';
import { StaffContext } from './staff-context.js';
import { StaffRepository, type StaffRow } from './staff.repository.js';

/** The names of the sections and subjects of a page of assignments, by ID. */
interface Names {
  sections: Awaited<ReturnType<SectionDirectory['names']>>;
  subjects: Awaited<ReturnType<SubjectDirectory['names']>>;
}

/**
 * The audit value of a class teacher: the pair, kept whole, because the audit log keeps only the fields that changed
 * and the year must stay in the entry (`null` when there is no section).
 */
const led = (academicYearId: string, sectionId: string | null) => ({
  classTeacher: sectionId === null ? null : { academicYearId, sectionId },
});

/**
 * STF-09 and ASG-01 to ASG-03 (API design 10.5a): who leads and who teaches which section in an academic year.
 * Assignments are made only at the staff member's home Institution (extra Institutions are view-only, PRD 4), by
 * Society Owners and Institution Admins who reach it. Ending keeps the row as history. Every change runs in one
 * transaction with the staff record locked and its audit entry.
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly staff: StaffRepository,
    private readonly staffContext: StaffContext,
    private readonly scope: ScopeService,
    private readonly assignments: AssignmentRepository,
    private readonly years: AcademicYearDirectory,
    private readonly sections: SectionDirectory,
    private readonly subjects: SubjectDirectory,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * STF-09: the section the staff member leads in the year, or `null` to end it. One section a class teacher and one
   * class teacher a section: a teacher who already leads another section that year moves to this one. 404 for a
   * record the caller does not reach or that is deactivated, and for a year or section that is not found; 422
   * `REFERENCE_INACTIVE` for a deactivated one; 422 `STAFF_BLOCKED`; 409
   * `CLASS_TEACHER_TAKEN` when another teacher leads the section. A request that changes nothing writes nothing.
   */
  async setClassTeacher(
    principal: Principal,
    staffMemberId: string,
    body: SetClassTeacherDto,
  ): Promise<ClassTeacherResource | null> {
    const context = await this.staffContext.of(principal, staffMemberId);
    const now = this.clock.now();
    return this.database.transaction(context.tenant, async (tx) => {
      const record = await this.staffContext.lockedActive(tx, staffMemberId);
      const leads = (await this.assignments.classTeacherOf(tx, staffMemberId)).find(
        (row) => row.academic_year_id === body.academicYearId,
      );
      if (body.sectionId === null) {
        if (leads) await this.endClassTeacher(tx, record, leads, principal, now);
        return null;
      }
      if (leads?.section_id === body.sectionId) return classTeacherResource(leads);
      await this.requireAssignable(tx, record, body.academicYearId, body.sectionId);
      if (leads) await this.assignments.endClassTeacher(tx, leads.id, principal.personId, now);
      const added = await this.assignments
        .insertClassTeacher(tx, {
          created_by: principal.personId,
          created_at: now,
          society_id: record.society_id,
          institution_id: record.home_institution_id,
          academic_year_id: body.academicYearId,
          section_id: body.sectionId,
          staff_member_id: staffMemberId,
        })
        .catch((error: unknown) => {
          throw isDuplicateOn(error, 'uq_class_teacher_section')
            ? AppException.conflict(ErrorCode.CLASS_TEACHER_TAKEN)
            : error;
        });
      await this.audit.record(tx, {
        action: 'staff.class_teacher_changed',
        institutionId: record.home_institution_id,
        entityType: 'staff_member',
        entityId: staffMemberId,
        before: led(body.academicYearId, leads?.section_id ?? null),
        after: led(body.academicYearId, body.sectionId),
      });
      return classTeacherResource(added);
    });
  }

  /**
   * ASG-01: the active teaching assignments of one Institution's academic year (the current one when none is named),
   * by teacher name, a page at a time. A teacher reads their own only. 404 for an Institution the caller does not
   * reach. An Institution with no current year has no assignments to list.
   */
  async list(
    principal: Principal,
    query: ListTeachingAssignmentsQueryDto,
  ): Promise<ApiResult<TeachingAssignmentResource[]>> {
    const context = await this.scope.requireInstitution(principal, query.institutionId);
    const { rows, total, names } = await this.database.transaction(context.tenant, async (tx) => {
      const academicYearId =
        query.academicYearId ?? (await this.years.currentId(tx, context.institutionId));
      const staffMemberId = await this.readerFilter(tx, principal, query.staffMemberId);
      const page =
        academicYearId === null || staffMemberId === null
          ? { rows: [] as TeachingView[], total: 0 }
          : await this.assignments.pageTeaching(
              tx,
              {
                institutionId: context.institutionId,
                academicYearId,
                sectionId: query.sectionId,
                subjectId: query.subjectId,
                staffMemberId,
              },
              query.limit,
              pageOffset(query.page, query.limit),
            );
      return { ...page, names: await this.namesOf(tx, page.rows) };
    });
    return ApiResult.list(
      rows.map((row) => teachingResource(row, this.nameOf(names, row))),
      pageMeta(query.page, query.limit, total),
    );
  }

  /**
   * ASG-02: assigns a teacher to a section and subject for the year. As STF-09 for the record, the year and the
   * section; the subject must exist (404) and be active (422 `REFERENCE_INACTIVE`) and be one the teacher can teach
   * (422 `SUBJECT_NOT_TAUGHT`); 409 `DUPLICATE` when the same assignment holds.
   */
  async create(
    principal: Principal,
    body: CreateTeachingAssignmentDto,
  ): Promise<TeachingAssignmentResource> {
    const context = await this.staffContext.of(principal, body.staffMemberId);
    const now = this.clock.now();
    return this.database.transaction(context.tenant, async (tx) => {
      const record = await this.staffContext.lockedActive(tx, body.staffMemberId);
      await this.requireAssignable(tx, record, body.academicYearId, body.sectionId);
      await this.subjects.requireActive(tx, [body.subjectId], 'subjectId');
      if (!(await this.staff.subjectIds(tx, record.id)).includes(body.subjectId)) {
        throw AppException.businessRule(ErrorCode.SUBJECT_NOT_TAUGHT);
      }
      const added = await this.assignments
        .insertTeaching(tx, {
          created_by: principal.personId,
          created_at: now,
          society_id: record.society_id,
          institution_id: record.home_institution_id,
          academic_year_id: body.academicYearId,
          section_id: body.sectionId,
          subject_id: body.subjectId,
          staff_member_id: record.id,
        })
        .catch((error: unknown) => {
          throw isDuplicateOn(error, 'uq_teaching_assignments_active')
            ? duplicateOn('subjectId')
            : error;
        });
      await this.audit.record(tx, {
        action: 'assignment.created',
        institutionId: record.home_institution_id,
        entityType: 'teaching_assignment',
        entityId: added.id,
        after: {
          staffMemberId: record.id,
          academicYearId: body.academicYearId,
          sectionId: body.sectionId,
          subjectId: body.subjectId,
        },
      });
      const view: TeachingView = {
        ...added,
        staff_first_name: record.first_name,
        staff_last_name: record.last_name,
      };
      return teachingResource(view, this.nameOf(await this.namesOf(tx, [view]), view));
    });
  }

  /**
   * ASG-03: ends the assignment; the row stays as history. 404 for one the caller does not reach, one that does not
   * exist and one that has already ended.
   */
  async end(principal: Principal, id: string): Promise<void> {
    const scope = await this.scope.forPrincipal(principal);
    const found = await this.database.transaction(scope.tenant, (tx) =>
      this.assignments.findTeaching(tx, id),
    );
    if (found?.ended_at !== null) throw AppException.notFound();
    const context = await this.scope.requireInstitution(principal, found.institution_id);
    const now = this.clock.now();
    await this.database.transaction(context.tenant, async (tx) => {
      const locked = await this.assignments.findTeaching(tx, id, true);
      if (locked?.ended_at !== null) throw AppException.notFound();
      await this.assignments.endTeaching(tx, id, principal.personId, now);
      await this.audit.record(tx, {
        action: 'assignment.ended',
        institutionId: locked.institution_id,
        entityType: 'teaching_assignment',
        entityId: id,
        before: {
          staffMemberId: locked.staff_member_id,
          academicYearId: locked.academic_year_id,
          sectionId: locked.section_id,
          subjectId: locked.subject_id,
        },
      });
    });
  }

  /**
   * Whether the staff member may be given this section for this year: not blocked (422 `STAFF_BLOCKED`), the year an
   * active year of their home Institution, the section an active section of it. The caller's tenant is narrowed to
   * the home Institution, so a section of another one is not found (404); the database keys back that up.
   */
  private async requireAssignable(
    tx: Tx,
    record: StaffRow,
    academicYearId: string,
    sectionId: string,
  ): Promise<void> {
    if (record.access_blocked_at !== null) throw AppException.businessRule(ErrorCode.STAFF_BLOCKED);
    await this.years.requireActive(
      tx,
      academicYearId,
      record.home_institution_id,
      'academicYearId',
    );
    await this.sections.requireActive(tx, sectionId, 'sectionId');
  }

  private async endClassTeacher(
    tx: Tx,
    record: StaffRow,
    row: ClassTeacherRow,
    principal: Principal,
    now: Date,
  ): Promise<void> {
    await this.assignments.endClassTeacher(tx, row.id, principal.personId, now);
    await this.audit.record(tx, {
      action: 'staff.class_teacher_changed',
      institutionId: record.home_institution_id,
      entityType: 'staff_member',
      entityId: record.id,
      before: led(row.academic_year_id, row.section_id),
      after: led(row.academic_year_id, null),
    });
  }

  /**
   * Whose assignments the caller reads: everyone's for an Owner or an Admin (the staff member asked for, if any), a
   * teacher's own for a teacher. `null` when there is nobody to read: a teacher with no record, or one who asks for
   * somebody else's.
   */
  private async readerFilter(
    tx: Tx,
    principal: Principal,
    asked: string | undefined,
  ): Promise<string | undefined | null> {
    if (principal.roleCode !== RoleCode.TeacherStaff) return asked;
    const own = await this.staff.activeOfUser(tx, principal.personId);
    return own && (asked === undefined || asked === own.id) ? own.id : null;
  }

  private nameOf(names: Names, row: TeachingView) {
    return {
      section: names.sections.get(row.section_id)!,
      subject: names.subjects.get(row.subject_id)!,
    };
  }

  private async namesOf(tx: Tx, rows: readonly TeachingView[]): Promise<Names> {
    return {
      sections: await this.sections.names(tx, [...new Set(rows.map((row) => row.section_id))]),
      subjects: await this.subjects.names(tx, [...new Set(rows.map((row) => row.subject_id))]),
    };
  }
}
