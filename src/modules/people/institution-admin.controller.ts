import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { GrantAdminDto, ListAdminsQueryDto } from './institution-admin.dto.js';
import type { InstitutionAdminResource } from './institution-admin.resource.js';
import { InstitutionAdminService } from './institution-admin.service.js';

const OWNER = [RoleCode.SocietyOwner];

/** INS-08 to INS-10 (API design 10.5): the Admins of an Institution, promoted from its staff. */
@ApiTags('Institutions')
@Controller('institutions/:institutionId/admins')
export class InstitutionAdminController {
  constructor(private readonly admins: InstitutionAdminService) {}

  @Policy({
    roles: OWNER,
    scope: 'institution',
    operationId: 'INS-08',
    rule: 'Lists the Admins of an Institution of the Owner’s Society, a page at a time, by name',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Query() query: ListAdminsQueryDto,
  ): Promise<ApiResult<InstitutionAdminResource[]>> {
    return this.admins.list(principal, institutionId, query);
  }

  @Policy({
    roles: OWNER,
    scope: 'institution',
    operationId: 'INS-09',
    rule: 'Promotes a staff member whose home or extra Institution this is to its Admin; the person is told by email after the commit',
  })
  @Post()
  async grant(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Body() body: GrantAdminDto,
  ): Promise<ApiResult<InstitutionAdminResource>> {
    return ApiResult.created(await this.admins.grant(principal, institutionId, body));
  }

  @Policy({
    roles: OWNER,
    scope: 'institution',
    operationId: 'INS-10',
    rule: 'Takes the Admin access of a staff member to this Institution away and ends their Admin sessions in the Society',
  })
  @Delete(':staffMemberId')
  revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
  ): Promise<void> {
    return this.admins.revoke(principal, institutionId, staffMemberId);
  }
}
