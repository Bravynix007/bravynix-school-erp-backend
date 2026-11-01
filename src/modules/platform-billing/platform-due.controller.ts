import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import type { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { IDEMPOTENCY_HEADER } from '../../platform/idempotency/index.js';
import {
  CancelDueDto,
  DueQuoteQueryDto,
  ListDuesQueryDto,
  MarkDuePaidDto,
  RaiseDueDto,
  UpdateDueDto,
} from './due.dto.js';
import type { DueQuote, DueResource, DueSummary } from './due.resource.js';
import { DueService } from './due.service.js';

/** PLT-24 to PLT-30: Super Admin quotes, raises, reads, edits, settles and cancels the dues of Institutions (PRD 9.3). */
@ApiTags('Platform: Dues')
@Controller('platform')
export class PlatformDueController {
  constructor(private readonly dues: DueService) {}

  @superAdminPolicy(
    'PLT-24',
    "Prefills a due: the automatic student count and the rate in force on the period's first day",
  )
  @Get('institutions/:institutionId/due-quote')
  quote(
    @CurrentPrincipal() principal: Principal,
    @Param('institutionId', UuidParamPipe) institutionId: string,
    @Query() query: DueQuoteQueryDto,
  ): Promise<DueQuote> {
    return this.dues.quote(principal, institutionId, query);
  }

  @superAdminPolicy(
    'PLT-25',
    'Lists dues across Societies, filtered by Society, Institution or status',
  )
  @Get('dues')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListDuesQueryDto,
  ): Promise<ApiResult<DueSummary[]>> {
    return this.dues.list(principal, query);
  }

  @superAdminPolicy(
    'PLT-26',
    'Raises a due with the rate frozen at the period start and emails the Society Owners',
  )
  @ApiHeader({ name: IDEMPOTENCY_HEADER, required: true, description: 'A UUID; a retry reuses it' })
  @Post('dues')
  raise(
    @CurrentPrincipal() principal: Principal,
    @Headers(IDEMPOTENCY_HEADER) key: string | string[] | undefined,
    @Body() body: RaiseDueDto,
  ): Promise<ApiResult<DueResource>> {
    return this.dues.raise(principal, key, body);
  }

  @superAdminPolicy('PLT-27', 'Reads one due with its frozen rate, amounts, notes and payment')
  @Get('dues/:dueId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('dueId', UuidParamPipe) dueId: string,
  ): Promise<DueResource> {
    return this.dues.get(principal, dueId);
  }

  @superAdminPolicy('PLT-28', 'Edits a due while it is still Due; the amounts are worked out again')
  @Patch('dues/:dueId')
  edit(
    @CurrentPrincipal() principal: Principal,
    @Param('dueId', UuidParamPipe) dueId: string,
    @Body() body: UpdateDueDto,
  ): Promise<DueResource> {
    return this.dues.edit(principal, dueId, body);
  }

  @superAdminPolicy('PLT-29', 'Records the payment of a due: the date, the mode and a reference')
  @Post('dues/:dueId/mark-paid')
  markPaid(
    @CurrentPrincipal() principal: Principal,
    @Param('dueId', UuidParamPipe) dueId: string,
    @Body() body: MarkDuePaidDto,
  ): Promise<DueResource> {
    return this.dues.markPaid(principal, dueId, body);
  }

  @superAdminPolicy('PLT-30', 'Cancels a due that is still Due, with a reason')
  @Post('dues/:dueId/cancel')
  cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('dueId', UuidParamPipe) dueId: string,
    @Body() body: CancelDueDto,
  ): Promise<DueResource> {
    return this.dues.cancel(principal, dueId, body);
  }
}
