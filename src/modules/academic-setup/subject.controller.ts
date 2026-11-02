import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateSubjectDto, UpdateSubjectDto } from './subject.dto.js';
import type { SubjectResource } from './subject.resource.js';
import { SubjectService } from './subject.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** SUB-01 to SUB-04 (API design 10.4i): the subjects of the caller's Society. */
@ApiTags('Subjects')
@Controller('subjects')
export class SubjectController {
  constructor(private readonly subjects: SubjectService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff],
    scope: 'society',
    operationId: 'SUB-01',
    rule: 'The active subjects of the caller’s Society, one list shared by its Institutions',
  })
  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<ApiResult<SubjectResource[]>> {
    return this.subjects.list(principal);
  }

  @Policy({
    roles: WRITERS,
    scope: 'society',
    operationId: 'SUB-02',
    rule: 'Adds a subject to the caller’s Society; the name and the code are unique among its active subjects',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateSubjectDto,
  ): Promise<ApiResult<SubjectResource>> {
    return ApiResult.created(await this.subjects.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'society',
    operationId: 'SUB-03',
    rule: 'Edits a subject for every Institution of the Society; the audit entry names who changed it',
  })
  @Patch(':subjectId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('subjectId', UuidParamPipe) subjectId: string,
    @Body() body: UpdateSubjectDto,
  ): Promise<SubjectResource> {
    return this.subjects.update(principal, subjectId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'society',
    operationId: 'SUB-04',
    rule: 'Deactivates a subject for every Institution of the Society; nothing is deleted',
  })
  @Delete(':subjectId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('subjectId', UuidParamPipe) subjectId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.subjects.deactivate(principal, subjectId);
  }
}
