import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateInstitutionDto, UpdateInstitutionDto } from './institution.dto.js';
import type { InstitutionOption, InstitutionResource } from './institution.resource.js';
import { InstitutionService } from './institution.service.js';

/** INS-01 to INS-05 (API design 10.4c): the Institutions of the caller's Society. */
@ApiTags('Institutions')
@Controller('institutions')
export class InstitutionController {
  constructor(private readonly institutions: InstitutionService) {}

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin, RoleCode.TeacherStaff],
    scope: 'society',
    operationId: 'INS-01',
    rule: 'The active Institutions the caller reaches; feeds the Institution switcher',
  })
  @Get()
  options(@CurrentPrincipal() principal: Principal): Promise<ApiResult<InstitutionOption[]>> {
    return this.institutions.options(principal);
  }

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.SuperAdmin],
    scope: 'society',
    operationId: 'INS-02',
    rule: 'An Owner adds to their own Society; Super Admin names the Society',
  })
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateInstitutionDto,
  ): Promise<ApiResult<InstitutionResource>> {
    return ApiResult.created(await this.institutions.create(principal, body));
  }

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin, RoleCode.TeacherStaff],
    scope: 'institution',
    operationId: 'INS-03',
    rule: 'An Institution in the caller’s scope; staff reach theirs when the People module lands',
  })
  @Get(':institutionId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
  ): Promise<InstitutionResource> {
    return this.institutions.get(principal, institutionId);
  }

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.SuperAdmin],
    scope: 'institution',
    operationId: 'INS-04',
    rule: 'Edits the profile; the code, Society, status and pause are not editable here',
  })
  @Patch(':institutionId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Body() body: UpdateInstitutionDto,
  ): Promise<InstitutionResource> {
    return this.institutions.update(principal, institutionId, body);
  }

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.SuperAdmin],
    scope: 'institution',
    operationId: 'INS-05',
    rule: 'Deactivates an Institution and ends its Admins’ grants; nothing is deleted',
  })
  @Delete(':institutionId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.institutions.deactivate(principal, institutionId);
  }
}
