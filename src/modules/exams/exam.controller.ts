import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateExamDto, ListExamsQueryDto, UpdateExamDto } from './exam.dto.js';
import type { ExamResource } from './exam.resource.js';
import { ExamService } from './exam.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** EXM-01 to EXM-04 (API design 9.8): the exams of an Institution's academic year (PRD 7.11). */
@ApiTags('Exams')
@Controller('exams')
export class ExamController {
  constructor(private readonly exams: ExamService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent],
    scope: 'institution',
    operationId: 'EXM-01',
    rule: 'The active exams of an Institution’s academic year, the earliest first: the year named or its current year (422 CURRENT_YEAR_REQUIRED when it has none); a parent names their own child with `studentId` instead of the Institution and the year (404 for any other child, 403 CHILD_ACCESS_BLOCKED for a blocked one)',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListExamsQueryDto,
  ): Promise<ApiResult<ExamResource[]>> {
    return this.exams.list(principal, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EXM-02',
    rule: 'Adds an exam to an active academic year of an Institution the caller administers, its current year when none is named (422 CURRENT_YEAR_REQUIRED); the name is unused among the year’s active exams (409 DUPLICATE), the type is 1 to 6 (400 INVALID_CODE) and both dates are inside the year, the end not before the start (400 OUT_OF_RANGE)',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateExamDto,
  ): Promise<ApiResult<ExamResource>> {
    return ApiResult.created(await this.exams.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EXM-03',
    rule: 'Changes an active exam’s name, type or dates; versioned; the same refusals as EXM-02',
  })
  @Patch(':examId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('examId', UuidParamPipe) examId: string,
    @Body() body: UpdateExamDto,
  ): Promise<ExamResource> {
    return this.exams.update(principal, examId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'EXM-04',
    rule: 'Deactivates an active exam; its name is free again; nothing is deleted',
  })
  @Delete(':examId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('examId', UuidParamPipe) examId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.exams.deactivate(principal, examId);
  }
}
