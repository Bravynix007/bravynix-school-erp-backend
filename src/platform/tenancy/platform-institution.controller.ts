import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { ListInstitutionsQueryDto } from './institution.dto.js';
import type { InstitutionResource, InstitutionSummary } from './institution.resource.js';
import { InstitutionService } from './institution.service.js';
import { PauseSocietyDto } from './society.dto.js';

/** The platform policy every route here shares: Super Admin only (API design 10.4c). */
const superAdmin = (operationId: string, rule: string) =>
  Policy({ roles: [RoleCode.SuperAdmin], scope: 'platform', operationId, rule });

/** PLT-19 to PLT-21: Super Admin looks across Societies and pauses one Institution. */
@ApiTags('Platform: Institutions')
@Controller('platform/institutions')
export class PlatformInstitutionController {
  constructor(private readonly institutions: InstitutionService) {}

  @superAdmin('PLT-19', 'Lists Institutions across Societies, with filters and sorting')
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListInstitutionsQueryDto,
  ): Promise<ApiResult<InstitutionSummary[]>> {
    return this.institutions.list(principal, query);
  }

  @superAdmin('PLT-20', 'Pauses one Institution’s access with a reason; no data changes')
  @HttpCode(HttpStatus.OK)
  @Post(':institutionId/pause')
  pause(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Body() body: PauseSocietyDto,
  ): Promise<InstitutionResource> {
    return this.institutions.pause(principal, institutionId, body);
  }

  @superAdmin('PLT-21', 'Resumes a paused Institution')
  @HttpCode(HttpStatus.OK)
  @Post(':institutionId/resume')
  resume(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Body() body: VersionDto,
  ): Promise<InstitutionResource> {
    return this.institutions.resume(principal, institutionId, body);
  }
}
