import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { VersionedReasonDto } from '../../common/validation/reason.dto.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { CreateSocietyDto, ListSocietiesQueryDto, UpdateSocietyDto } from './society.dto.js';
import type { SocietyDetail, SocietyResource, SocietySummary } from './society.resource.js';
import { SocietyService } from './society.service.js';

@ApiTags('Platform: Societies')
@Controller('platform/societies')
export class SocietyController {
  constructor(private readonly societies: SocietyService) {}

  @superAdminPolicy('PLT-02', 'Lists every Society, with filters and sorting')
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListSocietiesQueryDto,
  ): Promise<ApiResult<SocietySummary[]>> {
    return this.societies.list(principal, query);
  }

  @superAdminPolicy('PLT-03', 'Creates a Society; the code is unique and never changes')
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateSocietyDto,
  ): Promise<ApiResult<SocietyDetail>> {
    return ApiResult.created(await this.societies.create(principal, body));
  }

  @superAdminPolicy('PLT-04', 'One Society with its Institutions and Owners')
  @Get(':societyId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('societyId', UuidParamPipe) societyId: string,
  ): Promise<SocietyDetail> {
    return this.societies.get(principal, societyId);
  }

  @superAdminPolicy('PLT-05', 'Edits the profile; the code, status and pause are not editable here')
  @Patch(':societyId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('societyId', UuidParamPipe) societyId: string,
    @Body() body: UpdateSocietyDto,
  ): Promise<SocietyResource> {
    return this.societies.update(principal, societyId, body);
  }

  @superAdminPolicy(
    'PLT-06',
    'Deactivates a Society and ends its people’s access; nothing is deleted',
  )
  @Delete(':societyId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('societyId', UuidParamPipe) societyId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.societies.deactivate(principal, societyId);
  }

  @superAdminPolicy('PLT-07', 'Pauses a Society’s access with a reason; no data changes')
  @HttpCode(HttpStatus.OK)
  @Post(':societyId/pause')
  pause(
    @CurrentPrincipal() principal: Principal,
    @Param('societyId', UuidParamPipe) societyId: string,
    @Body() body: VersionedReasonDto,
  ): Promise<SocietyResource> {
    return this.societies.pause(principal, societyId, body);
  }

  @superAdminPolicy('PLT-08', 'Resumes a paused Society')
  @HttpCode(HttpStatus.OK)
  @Post(':societyId/resume')
  resume(
    @CurrentPrincipal() principal: Principal,
    @Param('societyId', UuidParamPipe) societyId: string,
    @Body() body: VersionDto,
  ): Promise<SocietyResource> {
    return this.societies.resume(principal, societyId, body);
  }
}
