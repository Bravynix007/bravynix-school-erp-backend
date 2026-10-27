import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateAccessBlockDto, ListAccessBlocksQueryDto } from './access-block.dto.js';
import type { AccessBlockResource } from './access-block.resource.js';
import { AccessBlockService } from './access-block.service.js';

/** PLT-42 to PLT-44: Super Admin blocks and unblocks a section of a Society's people (API design 10.4e). */
@ApiTags('Platform: Access blocks')
@Controller('platform/access-blocks')
export class PlatformAccessBlockController {
  constructor(private readonly blocks: AccessBlockService) {}

  @superAdminPolicy(
    'PLT-42',
    'Blocks the Owners of a Society, or the staff or students of one Institution, with a reason',
  )
  @Post()
  async block(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateAccessBlockDto,
  ): Promise<ApiResult<AccessBlockResource>> {
    return ApiResult.created(await this.blocks.block(principal, body));
  }

  @superAdminPolicy('PLT-43', 'Lifts a block; the row stays as history')
  @HttpCode(HttpStatus.OK)
  @Delete(':blockId')
  lift(
    @CurrentPrincipal() principal: Principal,
    @Param('blockId', UuidParamPipe) blockId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.blocks.lift(principal, blockId);
  }

  @superAdminPolicy('PLT-44', 'Lists the active blocks, with filters')
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListAccessBlocksQueryDto,
  ): Promise<ApiResult<AccessBlockResource[]>> {
    return this.blocks.list(principal, query);
  }
}
