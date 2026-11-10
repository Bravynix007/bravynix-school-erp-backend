import { Controller, Delete, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { DocumentService } from './document.service.js';

/** DOC-03 (API design 10.5b): deactivates a document. */
@ApiTags('Documents')
@Controller('documents')
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Policy({
    roles: [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin],
    scope: 'institution',
    operationId: 'DOC-03',
    rule: 'Deactivates a document of an Institution the caller reaches; nothing is deleted and the file is removed after 30 days',
  })
  @Delete(':documentId')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('documentId', UuidParamPipe) documentId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.documents.deactivate(principal, documentId);
  }
}
