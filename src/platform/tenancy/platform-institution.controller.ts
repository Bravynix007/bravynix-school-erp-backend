import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { ListInstitutionsQueryDto } from './institution.dto.js';
import type { InstitutionResource, InstitutionSummary } from './institution.resource.js';
import { InstitutionService } from './institution.service.js';
import { VersionedReasonDto } from '../../common/validation/reason.dto.js';

/** PLT-19 to PLT-21: Super Admin looks across Societies and pauses one Institution. */
@ApiTags('Platform: Institutions')
@Controller('platform/institutions')
export class PlatformInstitutionController {
  constructor(private readonly institutions: InstitutionService) {}

  @superAdminPolicy('PLT-19', 'Lists Institutions across Societies, with filters and sorting')
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListInstitutionsQueryDto,
  ): Promise<ApiResult<InstitutionSummary[]>> {
    return this.institutions.list(principal, query);
  }

  @superAdminPolicy('PLT-20', 'Pauses one Institution’s access with a reason; no data changes')
  @HttpCode(HttpStatus.OK)
  @Post(':institutionId/pause')
  pause(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Body() body: VersionedReasonDto,
  ): Promise<InstitutionResource> {
    return this.institutions.pause(principal, institutionId, body);
  }

  @superAdminPolicy('PLT-21', 'Resumes a paused Institution')
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
