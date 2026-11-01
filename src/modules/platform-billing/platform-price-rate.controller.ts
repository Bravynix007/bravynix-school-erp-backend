import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { SetPriceRateDto } from './price-rate.dto.js';
import type { PriceRateResource } from './price-rate.resource.js';
import { PriceRateService } from './price-rate.service.js';

/** PLT-22 and PLT-23: Super Admin reads and adds an Institution's per-student rate (PRD 9.2). */
@ApiTags('Platform: Pricing')
@Controller('platform/institutions/:institutionId/price-rates')
export class PlatformPriceRateController {
  constructor(private readonly rates: PriceRateService) {}

  @superAdminPolicy(
    'PLT-22',
    "Reads an Institution's rate history, with the rate in force today marked",
  )
  @Get()
  history(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
  ): Promise<ApiResult<PriceRateResource[]>> {
    return this.rates.history(principal, institutionId);
  }

  @superAdminPolicy(
    'PLT-23',
    'Adds a rate per student with its effective date; rates are only ever added',
  )
  @Post()
  async set(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Body() body: SetPriceRateDto,
  ): Promise<ApiResult<PriceRateResource>> {
    return ApiResult.created(await this.rates.set(principal, institutionId, body));
  }
}
