import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy } from '../../common/auth/policy.decorator.js';
import { RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { RequestUploadDto } from './files.dto.js';
import type { FileResource } from './files.resource.js';
import { FilesService, type UploadGrant } from './files.service.js';
import type { DownloadTicket } from './object-storage.js';

const ADMINS = [RoleCode.SocietyOwner, RoleCode.InstitutionAdmin];

/** FIL-01 to FIL-03 (API design 15): ask for an upload, confirm it, get a link to the file. */
@ApiTags('Files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Policy({
    roles: ADMINS,
    scope: 'institution',
    operationId: 'FIL-01',
    rule: 'Asks to upload a file for an Institution in scope; the purpose decides the types and who may ask (API design 15.2)',
  })
  @Post('uploads')
  async requestUpload(
    @CurrentPrincipal() principal: Principal,
    @Body() body: RequestUploadDto,
  ): Promise<ApiResult<UploadGrant>> {
    return ApiResult.created(await this.files.requestUpload(principal, body));
  }

  @Policy({
    roles: ADMINS,
    scope: 'society',
    operationId: 'FIL-02',
    rule: 'Only the uploader confirms; the server reads the stored file and checks its size and first bytes',
  })
  @Post(':fileId/confirm')
  confirm(
    @CurrentPrincipal() principal: Principal,
    @Param('fileId', UuidParamPipe) fileId: string,
  ): Promise<FileResource> {
    return this.files.confirm(principal, fileId);
  }

  @Policy({
    roles: ADMINS,
    scope: 'society',
    operationId: 'FIL-03',
    rule: 'The uploader, or an Owner or Admin of the file’s Institution, gets a five-minute link; document purposes are audited',
  })
  @Get(':fileId/download')
  download(
    @CurrentPrincipal() principal: Principal,
    @Param('fileId', UuidParamPipe) fileId: string,
  ): Promise<DownloadTicket> {
    return this.files.download(principal, fileId);
  }
}
