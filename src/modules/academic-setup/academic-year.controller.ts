import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import {
  CreateAcademicYearDto,
  ListAcademicYearsQueryDto,
  UpdateAcademicYearDto,
} from './academic-year.dto.js';
import type { AcademicYearResource } from './academic-year.resource.js';
import { AcademicYearService } from './academic-year.service.js';

const WRITERS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** AY-01 to AY-05 (API design 10.4h): the academic years of an Institution. */
@ApiTags('Academic years')
@Controller('academic-years')
export class AcademicYearController {
  constructor(private readonly years: AcademicYearService) {}

  @Policy({
    roles: [...WRITERS, RoleCode.TeacherStaff, RoleCode.StudentParent],
    scope: 'institution',
    operationId: 'AY-01',
    rule: 'The active years of an Institution in the caller’s scope; staff and parents reach one when the People module lands',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListAcademicYearsQueryDto,
  ): Promise<ApiResult<AcademicYearResource[]>> {
    return this.years.list(principal, query);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'AY-02',
    rule: 'Adds a year to an Institution in scope; the first one becomes current',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateAcademicYearDto,
  ): Promise<ApiResult<AcademicYearResource>> {
    return ApiResult.created(await this.years.create(principal, body));
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'AY-03',
    rule: 'Edits the name or dates of an active year; which year is current is AY-04',
  })
  @Patch(':academicYearId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('academicYearId', UuidParamPipe) academicYearId: string,
    @Body() body: UpdateAcademicYearDto,
  ): Promise<AcademicYearResource> {
    return this.years.update(principal, academicYearId, body);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'AY-04',
    rule: 'Makes the year current and the previous current year not',
  })
  @Post(':academicYearId/make-current')
  makeCurrent(
    @CurrentPrincipal() principal: Principal,
    @Param('academicYearId', UuidParamPipe) academicYearId: string,
    @Body() body: VersionDto,
  ): Promise<AcademicYearResource> {
    return this.years.makeCurrent(principal, academicYearId, body.version);
  }

  @Policy({
    roles: WRITERS,
    scope: 'institution',
    operationId: 'AY-05',
    rule: 'Deactivates a year that is not the current one; nothing is deleted',
  })
  @Delete(':academicYearId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('academicYearId', UuidParamPipe) academicYearId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.years.deactivate(principal, academicYearId);
  }
}
