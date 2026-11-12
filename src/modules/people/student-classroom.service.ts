import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { DatabaseService, type Tx } from '../../platform/database/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import { AcademicYearDirectory, TeachingStaff } from '../academic-setup/index.js';
import { StudentContext } from './student-context.js';
import type { ListStudentsQueryDto } from './student.dto.js';
import { StudentRepository, type PlacedRow, type StudentRow } from './student.repository.js';
import { studentClassroom, type StudentClassroomResource } from './student.resource.js';

/** A teacher sorts by what the classroom view shows. */
const CLASSROOM_SORT_FIELDS = ['name', 'rollNumber'] as const;

/**
 * STU-01 and STU-03 for a Teacher or Staff member (API design 6.4, D7): the students of the sections they lead or
 * teach this year, in the classroom view: placements of the current year only, and a search by name or roll
 * number (never the Admission ID, which the view hides). A student of another section of their own school is 403 `NOT_ASSIGNED`; a
 * student of an Institution they do not reach is 404. Deactivated students are not shown.
 */
@Injectable()
export class StudentClassroomService {
  constructor(
    private readonly database: DatabaseService,
    private readonly students: StudentRepository,
    private readonly scope: ScopeService,
    private readonly context: StudentContext,
    private readonly teaching: TeachingStaff,
    private readonly years: AcademicYearDirectory,
  ) {}

  /** STU-01: the students in the caller's own sections, filtered and searched as for an admin. */
  async list(
    principal: Principal,
    query: ListStudentsQueryDto,
  ): Promise<ApiResult<StudentClassroomResource[]>> {
    const scope = await this.scope.forPrincipal(principal);
    const institutionIds = query.institutionId
      ? [(await this.scope.requireInstitution(principal, query.institutionId)).institutionId]
      : (scope.tenant.institutionIds ?? []);
    const sort = parseSort(query.sort, CLASSROOM_SORT_FIELDS, [
      { field: 'name', direction: 'asc' },
    ]);
    const { rows, total } = await this.database.transaction(scope.tenant, async (tx) => {
      const own = new Set<string>();
      const current = new Set<string>();
      for (const institutionId of institutionIds) {
        const year = await this.years.currentId(tx, institutionId);
        if (year !== null) current.add(year);
        for (const id of await this.teaching.ownSectionIds(tx, principal.personId, institutionId)) {
          own.add(id);
        }
      }
      // A teacher's classroom is this year's: another year named lists nobody.
      if (query.academicYearId !== undefined && !current.has(query.academicYearId)) {
        return { rows: [], total: 0 };
      }
      return this.students.page(
        tx,
        {
          q: query.q,
          institutionIds,
          statuses: [1],
          academicYearId: query.academicYearId,
          classId: query.classId,
          sectionId: query.sectionId,
          inSectionIds: [...own],
          inYearIds: [...current],
          searchNameAndRollOnly: true,
        },
        sort,
        query.limit,
        pageOffset(query.page, query.limit),
      );
    });
    return ApiResult.list(
      rows.map((row) => studentClassroom(row, row)),
      pageMeta(query.page, query.limit, total),
    );
  }

  /** STU-03: one student of the caller's own sections. */
  async get(principal: Principal, id: string): Promise<StudentClassroomResource> {
    const context = await this.context.of(principal, id);
    return this.database.transaction(context.tenant, async (tx) => {
      const row = await this.students.find(tx, id);
      if (!row) throw AppException.notFound();
      const placed = await this.ownPlacement(tx, principal, context.institutionId, row);
      return studentClassroom(row, placed);
    });
  }

  /**
   * The current placement of a student the caller leads or teaches this year, for the classroom view. 403
   * `NOT_ASSIGNED` for a deactivated student, one with no placement, one in another section and one placed in another
   * year than the current.
   */
  async ownPlacement(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    row: StudentRow,
  ): Promise<PlacedRow> {
    const placed = row.status === 1 ? await this.students.placedNow(tx, row.id) : undefined;
    return this.requireOwnSection(tx, principal, institutionId, placed);
  }

  /**
   * The placement must be in a section the caller leads or teaches, in the Institution's current year (a star is given
   * for the placement the caller chose, not the latest one); 403 `NOT_ASSIGNED` otherwise.
   */
  async requireOwnSection(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    placed: PlacedRow | undefined,
  ): Promise<PlacedRow> {
    const own = await this.teaching.ownSectionIds(tx, principal.personId, institutionId);
    const current = await this.years.currentId(tx, institutionId);
    if (!placed || !own.has(placed.section_id) || placed.academic_year_id !== current) {
      throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
    }
    return placed;
  }
}
