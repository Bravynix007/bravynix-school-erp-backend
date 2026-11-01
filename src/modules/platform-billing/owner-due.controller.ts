import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import type { OwnerDue, OwnerDues } from './due.resource.js';
import { OwnerDueService } from './owner-due.service.js';

/** BIL-01 and BIL-02: a Society Owner reads the platform dues of their Society (PRD 9.3). */
@ApiTags('Society: Platform dues')
@Controller('platform-dues')
export class OwnerDueController {
  constructor(private readonly dues: OwnerDueService) {}

  @Policy({
    roles: [RoleCode.SocietyOwner],
    scope: 'society',
    operationId: 'BIL-01',
    rule: 'The total still due and the dues of the Owner’s own Society, newest first; open while the Owners are blocked',
    allowWhenBlocked: true,
  })
  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<OwnerDues> {
    return this.dues.list(principal);
  }

  @Policy({
    roles: [RoleCode.SocietyOwner],
    scope: 'society',
    operationId: 'BIL-02',
    rule: 'One due of the Owner’s own Society; open while the Owners are blocked',
    allowWhenBlocked: true,
  })
  @Get(':dueId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('dueId', UuidParamPipe) dueId: string,
  ): Promise<OwnerDue> {
    return this.dues.get(principal, dueId);
  }
}
