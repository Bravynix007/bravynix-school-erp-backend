import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { ListInstitutionsQueryDto } from './institution.dto.js';
import type { InstitutionSummary } from './institution.resource.js';
import { InstitutionService } from './institution.service.js';

/** PLT-19: Super Admin looks across Societies at their Institutions, read-only. */
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
}
