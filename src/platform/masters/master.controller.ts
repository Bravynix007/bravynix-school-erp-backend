import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { ALL_ROLES } from '../../common/auth/roles.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { MASTER_TYPES, type MasterSpec } from './master.catalog.js';
import { MasterQueryDto } from './master.dto.js';
import { MasterTypePipe } from './master-type.pipe.js';
import type { MasterEntry } from './master.resource.js';
import { MasterService } from './master.service.js';

/** MST-01 (API design 10.4g): the platform masters every signed-in person picks from. */
@ApiTags('Masters')
@Controller('masters')
export class MasterController {
  constructor(private readonly masters: MasterService) {}

  @Policy({
    roles: ALL_ROLES,
    scope: 'none',
    operationId: 'MST-01',
    rule: 'Everyone signed in reads the shown entries; includeHidden is for Super Admin only. Revalidate with If-None-Match',
  })
  @ApiParam({ name: 'masterType', enum: MASTER_TYPES })
  @Get(':masterType')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('masterType', MasterTypePipe) spec: MasterSpec,
    @Query() query: MasterQueryDto,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
  ): Promise<ApiResult<MasterEntry[] | null>> {
    return this.masters.list(principal, spec, query, ifNoneMatch);
  }
}
