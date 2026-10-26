import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { NewPersonDto } from '../identity/index.js';
import { ListOwnersQueryDto } from './society-owner.dto.js';
import type { SocietyOwnerResource, SocietyOwnerSummary } from './society-owner.resource.js';
import { SocietyOwnerService } from './society-owner.service.js';

/** PLT-09 to PLT-11: Super Admin looks after the Owners of Societies (API design 10.4d). */
@ApiTags('Platform: Society Owners')
@Controller('platform')
export class SocietyOwnerController {
  constructor(private readonly owners: SocietyOwnerService) {}

  @superAdminPolicy('PLT-09', 'Adds a Society Owner by email; at most three per Society')
  @Post('societies/:societyId/owners')
  async add(
    @CurrentPrincipal() principal: Principal,
    @Param('societyId', UuidParamPipe) societyId: string,
    @Body() body: NewPersonDto,
  ): Promise<ApiResult<SocietyOwnerResource>> {
    return ApiResult.created(await this.owners.add(principal, societyId, body));
  }

  @superAdminPolicy('PLT-10', 'Removes a Society Owner and ends their sessions in that Society')
  @Delete('societies/:societyId/owners/:userId')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('societyId', UuidParamPipe) societyId: string,
    @Param('userId', UuidParamPipe) userId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.owners.remove(principal, societyId, userId);
  }

  @superAdminPolicy('PLT-11', 'Lists the Owners of every Society')
  @Get('society-owners')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListOwnersQueryDto,
  ): Promise<ApiResult<SocietyOwnerSummary[]>> {
    return this.owners.list(principal, query);
  }
}
