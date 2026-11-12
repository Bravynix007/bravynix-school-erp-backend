import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { CreateDocumentDto } from './document.dto.js';
import type { DocumentResource } from './document.resource.js';
import { DocumentService } from './document.service.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** DOC-01 and DOC-02 (API design 9.6, 10.5b): the documents of a student. DOC-03 deactivates either kind. */
@ApiTags('Student documents')
@Controller('students')
export class StudentDocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'DOC-01',
    rule: 'The active documents of a student whose Institution the caller reaches, newest first; a teacher gets 403',
  })
  @Get(':studentId/documents')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
  ): Promise<ApiResult<DocumentResource[]>> {
    return this.documents.listOfStudent(principal, studentId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'DOC-02',
    rule: 'Attaches a Ready student-document file made for the student’s Institution to an active student',
  })
  @Post(':studentId/documents')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param('studentId', UuidParamPipe) studentId: string,
    @Body() body: CreateDocumentDto,
  ): Promise<ApiResult<DocumentResource>> {
    return ApiResult.created(await this.documents.createForStudent(principal, studentId, body));
  }
}
