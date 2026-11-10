import { Body, Controller, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { RevealIdentityDto, SetIdentityDto } from './identity.dto.js';
import type { IdentityResource, RevealResource } from './identity.resource.js';
import { StaffIdentityService } from './staff-identity.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** STF-11 and STF-12 (API design 6.8, 10.9): the Aadhaar number of a staff member. */
@ApiTags('Staff')
@Controller('staff')
export class StaffIdentityController {
  constructor(private readonly identity: StaffIdentityService) {}

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-11',
    rule: 'Sets or clears the Aadhaar number of an active staff member and answers with the masked number only; one record per number in the Society',
  })
  @Put(':staffMemberId/identity')
  set(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
    @Body() body: SetIdentityDto,
  ): Promise<IdentityResource> {
    return this.identity.set(principal, staffMemberId, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-12',
    rule: 'Shows the whole Aadhaar number to an admin who gives a reason; audited before the answer, at most ten a day for each admin',
  })
  @HttpCode(HttpStatus.OK)
  @Post(':staffMemberId/identity/reveal')
  reveal(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
    @Body() body: RevealIdentityDto,
  ): Promise<RevealResource> {
    return this.identity.reveal(principal, staffMemberId, body);
  }
}
