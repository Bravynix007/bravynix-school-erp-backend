import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiExtraModels, ApiParam, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { MASTER_TYPES, type MasterSpec } from './master.catalog.js';
import {
  CreateCityDto,
  CreateClassCategoryDto,
  CreateCountryDto,
  CreateDesignationDto,
  CreatePredefinedClassDto,
  CreatePredefinedSectionDto,
  CreateStateDto,
  UpdateCityDto,
  UpdateClassCategoryDto,
  UpdateCountryDto,
  UpdateDesignationDto,
  UpdatePredefinedClassDto,
  UpdatePredefinedSectionDto,
  UpdateStateDto,
} from './master.dto.js';
import { MasterTypePipe } from './master-type.pipe.js';
import type { MasterEntry } from './master.resource.js';
import { MasterService } from './master.service.js';

const CREATE_BODIES = [
  CreateCountryDto,
  CreateStateDto,
  CreateCityDto,
  CreateClassCategoryDto,
  CreatePredefinedClassDto,
  CreatePredefinedSectionDto,
  CreateDesignationDto,
];
const UPDATE_BODIES = [
  UpdateCountryDto,
  UpdateStateDto,
  UpdateCityDto,
  UpdateClassCategoryDto,
  UpdatePredefinedClassDto,
  UpdatePredefinedSectionDto,
  UpdateDesignationDto,
];
const oneOf = (bodies: readonly (new () => object)[]) => ({
  schema: { oneOf: bodies.map((body) => ({ $ref: getSchemaPath(body) })) },
  description: 'The body of the master named in the path (API design 10.4g)',
});

/**
 * PLT-31 to PLT-33: Super Admin keeps the platform masters. One route serves the seven; the body is
 * checked against the DTO of the master the path names, with the same rules as any other body.
 */
@ApiTags('Platform: Masters')
@ApiExtraModels(...CREATE_BODIES, ...UPDATE_BODIES)
@ApiParam({ name: 'masterType', enum: MASTER_TYPES })
@Controller('platform/masters/:masterType')
export class PlatformMasterController {
  constructor(private readonly masters: MasterService) {}

  @superAdminPolicy(
    'PLT-31',
    'Adds an entry to a master, last in its list or at displayOrder; places are kept by name',
  )
  @ApiBody(oneOf(CREATE_BODIES))
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param('masterType', MasterTypePipe) spec: MasterSpec,
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResult<MasterEntry>> {
    return ApiResult.created(await this.masters.create(principal, spec, body));
  }

  @superAdminPolicy(
    'PLT-32',
    'Edits an entry, moves it with displayOrder, hides or shows it with status; version required',
  )
  @ApiBody(oneOf(UPDATE_BODIES))
  @Patch(':entryId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('masterType', MasterTypePipe) spec: MasterSpec,
    @Param('entryId', UuidParamPipe) entryId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<MasterEntry> {
    return this.masters.update(principal, spec, entryId, body);
  }

  @superAdminPolicy(
    'PLT-33',
    'Hides an entry from pickers; entries other records point at are never deleted',
  )
  @Delete(':entryId')
  hide(
    @CurrentPrincipal() principal: Principal,
    @Param('masterType', MasterTypePipe) spec: MasterSpec,
    @Param('entryId', UuidParamPipe) entryId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.masters.hide(principal, spec, entryId);
  }
}
