import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateStaffDocumentDto } from './document.dto.js';
import type { DocumentResource } from './document.resource.js';
import { DocumentService } from './document.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** STF-14 and STF-15 (API design 9.5, 10.5b): the documents of a staff member. */
@ApiTags('Staff documents')
@Controller('staff')
export class StaffDocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Policy({
    roles: [...ADMINS, RoleCode.TeacherStaff],
    scope: 'institution',
    operationId: 'STF-14',
    rule: 'The active documents of a staff member the caller reaches, newest first; a teacher reads their own only',
  })
  @Get(':staffMemberId/documents')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
  ): Promise<ApiResult<DocumentResource[]>> {
    return this.documents.list(principal, staffMemberId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'STF-15',
    rule: 'Attaches a Ready staff-document file made for the home Institution to an active staff member',
  })
  @Post(':staffMemberId/documents')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param('staffMemberId', UuidParamPipe) staffMemberId: string,
    @Body() body: CreateStaffDocumentDto,
  ): Promise<ApiResult<DocumentResource>> {
    return ApiResult.created(await this.documents.create(principal, staffMemberId, body));
  }
}
