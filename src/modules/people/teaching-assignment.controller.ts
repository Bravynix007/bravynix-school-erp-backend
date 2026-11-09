import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateTeachingAssignmentDto, ListTeachingAssignmentsQueryDto } from './assignment.dto.js';
import type { TeachingAssignmentResource } from './assignment.resource.js';
import { AssignmentService } from './assignment.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** ASG-01 to ASG-03 (API design 10.5a): who teaches which section and subject. */
@ApiTags('Teaching assignments')
@Controller('teaching-assignments')
export class TeachingAssignmentController {
  constructor(private readonly assignments: AssignmentService) {}

  @Policy({
    roles: [...ADMINS, RoleCode.TeacherStaff],
    scope: 'institution',
    operationId: 'ASG-01',
    rule: 'The active teaching assignments of an Institution the caller reaches, for a year; a teacher reads their own only',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListTeachingAssignmentsQueryDto,
  ): Promise<ApiResult<TeachingAssignmentResource[]>> {
    return this.assignments.list(principal, query);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'ASG-02',
    rule: 'Assigns a teacher to a section of their home Institution and a subject they can teach, for a year',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateTeachingAssignmentDto,
  ): Promise<ApiResult<TeachingAssignmentResource>> {
    return ApiResult.created(await this.assignments.create(principal, body));
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'ASG-03',
    rule: 'Ends a teaching assignment of an Institution the caller reaches; the row stays as history',
  })
  @Delete(':assignmentId')
  end(
    @CurrentPrincipal() principal: Principal,
    @Param('assignmentId', UuidParamPipe) assignmentId: string,
  ): Promise<void> {
    return this.assignments.end(principal, assignmentId);
  }
}
