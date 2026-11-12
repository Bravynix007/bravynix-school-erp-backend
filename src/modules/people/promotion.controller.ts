import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { IDEMPOTENCY_HEADER } from '../../platform/idempotency/index.js';
import { PromoteClassDto } from './promotion.dto.js';
import { PromotionService, type PromotionResult } from './promotion.service.js';

/** PRM-01 (API design 10.7): a whole class or section moves to the next academic year. */
@ApiTags('Promotions')
@Controller('promotions')
export class PromotionController {
  constructor(private readonly promotion: PromotionService) {}

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin],
    scope: 'institution',
    operationId: 'PRM-01',
    rule: 'Promotes the active students of a class or section of an Institution the caller reaches (up to 500, all or nothing, idempotent) to a class and section of the next academic year, or completes the final class; a student already in the new year is skipped',
  })
  @ApiHeader({ name: IDEMPOTENCY_HEADER, required: true, description: 'A UUID; a retry reuses it' })
  @Post()
  @HttpCode(HttpStatus.OK)
  promote(
    @CurrentPrincipal() principal: Principal,
    @Headers(IDEMPOTENCY_HEADER) key: string | string[] | undefined,
    @Body() body: PromoteClassDto,
  ): Promise<ApiResult<PromotionResult>> {
    return this.promotion.promoteClass(principal, key, body);
  }
}
