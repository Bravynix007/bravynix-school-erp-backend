import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { superAdminPolicy } from '../../common/auth/platform-policy.js';
import { ApiResult } from '../../common/http/api-result.js';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe.js';
import { ReasonDto, VersionedReasonDto } from '../../common/validation/reason.dto.js';
import { VersionDto } from '../../common/validation/version.dto.js';
import { ChangeEmailDto, NewPersonDto } from './account.dto.js';
import type { AccountResource, SuperAdminResource } from './account.resource.js';
import { PlatformAccountService } from './platform-account.service.js';

/** PLT-12 to PLT-18 and PLT-41: Super Admin looks after the platform's accounts (API design 10.4d). */
@ApiTags('Platform: Accounts')
@Controller('platform')
export class PlatformAccountController {
  constructor(private readonly accounts: PlatformAccountService) {}

  @superAdminPolicy('PLT-12', 'Lists the Super Admins')
  @Get('super-admins')
  list(@CurrentPrincipal() principal: Principal): Promise<ApiResult<SuperAdminResource[]>> {
    return this.accounts.listSuperAdmins(principal);
  }

  @superAdminPolicy('PLT-13', 'Adds a Super Admin by email; at most three')
  @Post('super-admins')
  async add(
    @CurrentPrincipal() principal: Principal,
    @Body() body: NewPersonDto,
  ): Promise<ApiResult<SuperAdminResource>> {
    return ApiResult.created(await this.accounts.addSuperAdmin(principal, body));
  }

  @superAdminPolicy('PLT-14', 'Removes a Super Admin; not yourself, so one always remains')
  @Delete('super-admins/:userId')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', UuidParamPipe) userId: string,
  ): Promise<{ id: string; status: 0 }> {
    return this.accounts.removeSuperAdmin(principal, userId);
  }

  @superAdminPolicy('PLT-15', 'Blocks a whole account and ends every session of the person')
  @HttpCode(HttpStatus.OK)
  @Post('users/:userId/block')
  block(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', UuidParamPipe) userId: string,
    @Body() body: VersionedReasonDto,
  ): Promise<AccountResource> {
    return this.accounts.block(principal, userId, body);
  }

  @superAdminPolicy('PLT-16', 'Unblocks an account')
  @HttpCode(HttpStatus.OK)
  @Post('users/:userId/unblock')
  unblock(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', UuidParamPipe) userId: string,
    @Body() body: VersionDto,
  ): Promise<AccountResource> {
    return this.accounts.unblock(principal, userId, body);
  }

  @superAdminPolicy(
    'PLT-17',
    'Changes a Society Owner’s or Super Admin’s email and ends their sessions',
  )
  @Put('users/:userId/email')
  changeEmail(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', UuidParamPipe) userId: string,
    @Body() body: ChangeEmailDto,
  ): Promise<AccountResource> {
    return this.accounts.changeEmail(principal, userId, body);
  }

  @superAdminPolicy(
    'PLT-18',
    'Resets another Super Admin’s authenticator; refused while it is locked',
  )
  @Delete('users/:userId/mfa')
  resetAuthenticator(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', UuidParamPipe) userId: string,
  ): Promise<{ id: string; authenticatorSetUp: false }> {
    return this.accounts.resetAuthenticator(principal, userId);
  }

  @superAdminPolicy(
    'PLT-41',
    'Support unlock: lifts a login lock and an authenticator lock, with a reason',
  )
  @HttpCode(HttpStatus.OK)
  @Post('users/:userId/unlock')
  unlock(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', UuidParamPipe) userId: string,
    @Body() body: ReasonDto,
  ): Promise<{ id: string; loginLockCleared: boolean; authenticatorLockCleared: boolean }> {
    return this.accounts.unlock(principal, userId, body);
  }
}
