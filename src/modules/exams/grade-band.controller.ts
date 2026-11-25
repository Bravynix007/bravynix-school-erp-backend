import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import {
  CreateGradeBandDto,
  ListGradeBandsQueryDto,
  UpdateGradeBandDto,
} from './grade-band.dto.js';
import type { GradeBandResource } from './grade-band.resource.js';
import { GradeBandService } from './grade-band.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** GRD-01 to GRD-04 (API design 9.4): the grade bands of an Institution (PRD 7.11). */
@ApiTags('Exams')
@Controller('grade-bands')
export class GradeBandController {
  constructor(private readonly bands: GradeBandService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent],
    scope: 'institution',
    operationId: 'GRD-01',
    rule: 'The active grade bands of an Institution, the highest first; a parent names their own child with `studentId` instead of the Institution (404 for any other child, 403 CHILD_ACCESS_BLOCKED for a blocked one)',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListGradeBandsQueryDto,
  ): Promise<ApiResult<GradeBandResource[]>> {
    return this.bands.list(principal, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'GRD-02',
    rule: 'Adds a grade band to an Institution the caller administers: the name is unused among its active bands (409 DUPLICATE), the minimum is not above the maximum (400 OUT_OF_RANGE on maxPercentage), and the range, both ends included, shares no value with another active band (409 GRADE_BAND_OVERLAP)',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateGradeBandDto,
  ): Promise<ApiResult<GradeBandResource>> {
    return ApiResult.created(await this.bands.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'GRD-03',
    rule: 'Changes an active band’s name, range, grade point or description; versioned; the same refusals as GRD-02; a published result keeps the grade it was published with',
  })
  @Patch(':gradeBandId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('gradeBandId', UuidParamPipe) gradeBandId: string,
    @Body() body: UpdateGradeBandDto,
  ): Promise<GradeBandResource> {
    return this.bands.update(principal, gradeBandId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'GRD-04',
    rule: 'Deactivates an active band; its name and range are free again; nothing is deleted',
  })
  @Delete(':gradeBandId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('gradeBandId', UuidParamPipe) gradeBandId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.bands.deactivate(principal, gradeBandId);
  }
}
