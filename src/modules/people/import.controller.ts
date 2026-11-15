import { Body, Controller, Get, Header, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { RawResponse } from '../../common/http/raw-response.decorator.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { IDEMPOTENCY_HEADER } from '../../platform/idempotency/index.js';
import { ListImportsQueryDto, StartImportDto } from './import.dto.js';
import type { ImportResource } from './import.resource.js';
import { ImportService, type ImportStarted } from './import.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** IMP-01 to IMP-04 (API design 9.6, 10.8): the student CSV import. */
@ApiTags('Imports')
@Controller('imports')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  @Policy({
    roles: ADMINS,
    scope: 'society',
    operationId: 'IMP-01',
    rule: 'The sample student CSV: the header and two example rows, as a text/csv file and not in the envelope',
  })
  @RawResponse()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="students-import-sample.csv"')
  @Header('Cache-Control', 'no-store')
  @Get('templates/students')
  template(): string {
    return this.imports.template();
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'IMP-02',
    rule: 'Starts a student import of an Institution the caller reaches from a Ready CSV file (purpose 12) that the caller uploaded, one run at a time for the Institution; the worker adds the students and the caller polls IMP-03',
  })
  @ApiHeader({ name: IDEMPOTENCY_HEADER, required: true, description: 'A UUID; a retry reuses it' })
  @Post()
  start(
    @CurrentPrincipal() principal: Principal,
    @Headers(IDEMPOTENCY_HEADER) key: string | string[] | undefined,
    @Body() body: StartImportDto,
  ): Promise<ApiResult<ImportStarted>> {
    return this.imports.start(principal, key, body);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'IMP-03',
    rule: 'The status of an import of an Institution the caller reaches: its progress, and once it has finished how many students were imported and the rows that were skipped with their reasons (404 for another Institution)',
  })
  @Get(':importId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('importId', UuidParamPipe) importId: string,
  ): Promise<ImportResource> {
    return this.imports.get(principal, importId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'IMP-04',
    rule: 'The recent imports of an Institution the caller reaches, newest first, kept 7 days (404 for another Institution)',
  })
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListImportsQueryDto,
  ): Promise<ApiResult<ImportResource[]>> {
    return this.imports.list(principal, query);
  }
}
