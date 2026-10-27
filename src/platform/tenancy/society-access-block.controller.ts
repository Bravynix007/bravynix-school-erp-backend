import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import type { ApiResult } from '../../common/http/api-result.js';
import type { SocietyBlockResource } from './access-block.resource.js';
import { AccessBlockService } from './access-block.service.js';

/** SOC-02: an Owner reads the blocks of their own Society and why (API design 10.4e). */
@ApiTags('Society')
@Controller('society/access-blocks')
export class SocietyAccessBlockController {
  constructor(private readonly blocks: AccessBlockService) {}

  @Policy({
    roles: [RoleCode.SocietyOwner],
    scope: 'society',
    operationId: 'SOC-02',
    rule: 'The active blocks of the Owner’s own Society; read-only, and open while the Owners are blocked',
    allowWhenBlocked: true,
  })
  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<ApiResult<SocietyBlockResource[]>> {
    return this.blocks.forSociety(principal);
  }
}
