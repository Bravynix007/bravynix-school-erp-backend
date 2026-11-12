import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { ErrorCode } from '../../common/http/error-codes.js';
import { pageMeta, pageOffset, parseSort } from '../../common/pagination/pagination.js';
import { DatabaseService } from '../../platform/database/index.js';
import { ScopeService } from '../../platform/tenancy/index.js';
import { TeachingStaff } from '../academic-setup/index.js';
import { StudentContext } from './student-context.js';
import type { ListStudentsQueryDto } from './student.dto.js';
import { StudentRepository } from './student.repository.js';
import { studentClassroom, type StudentClassroomResource } from './student.resource.js';

/** A teacher sorts by what the classroom view shows. */
const CLASSROOM_SORT_FIELDS = ['name', 'rollNumber'] as const;

/**
 * STU-01 and STU-03 for a Teacher or Staff member (API design 6.4, D7): the students of the sections they lead or
 * teach this year, in the classroom view. A student of another section of their own school is 403 `NOT_ASSIGNED`; a
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
      for (const institutionId of institutionIds) {
        for (const id of await this.teaching.ownSectionIds(tx, principal.personId, institutionId)) {
          own.add(id);
        }
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
      const placed = row.status === 1 ? await this.students.placedNow(tx, id) : undefined;
      const own = await this.teaching.ownSectionIds(tx, principal.personId, context.institutionId);
      if (!placed || !own.has(placed.section_id)) {
        throw AppException.forbidden(ErrorCode.NOT_ASSIGNED);
      }
      return studentClassroom(row, placed);
    });
  }
}
