import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy, Public } from '../../common/auth/policy.decorator.js';
import { ALL_ROLES, RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AuthCode } from './auth-codes.js';
import { LoginService, type LoginResult } from './login.service.js';
import { OtpService } from './otp.service.js';
import { OTP_LIMITS } from './otp-limits.js';
import { ContextService, type SwitchResult } from './context.service.js';
import { RefreshTokenDto } from './refresh-token.dto.js';
import { RequestOtpDto } from './request-otp.dto.js';
import { SessionService, type RefreshResult } from './session.service.js';
import { SwitchContextDto } from './switch-context.dto.js';
import { VerifyOtpDto } from './verify-otp.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly login: LoginService,
    private readonly sessions: SessionService,
    private readonly contexts: ContextService,
  ) {}

  @Public({
    operationId: 'AUTH-01',
    rule: 'Per-IP and per-email limits (API design 6.2); the same answer for every email',
  })
  @Post('otp')
  async requestCode(@Body() body: RequestOtpDto): Promise<ApiResult<Record<string, unknown>>> {
    const result = await this.otp.requestCode(body);
    return ApiResult.accepted(
      {
        resendAfterSeconds: OTP_LIMITS.resendGapSeconds,
        expiresInSeconds: OTP_LIMITS.codeLifeSeconds,
        // Development only (OTP_DEV_ECHO); the process refuses to start with it
        // on in staging or production.
        ...(result.devCode === undefined ? {} : { devOtp: result.devCode }),
      },
      AuthCode.OTP_SENT_IF_REGISTERED,
    );
  }

  @Public({
    operationId: 'AUTH-02',
    rule: 'Per-IP limit; 5 wrong codes per email lock it for 30 minutes, 24 hours from the third lockout in a day (API design 6.2); the same answers for every email',
  })
  @HttpCode(HttpStatus.OK)
  @Post('otp/verify')
  async verifyCode(@Body() body: VerifyOtpDto): Promise<ApiResult<LoginResult>> {
    return ApiResult.ok(await this.login.verify(body), AuthCode.LOGIN_OK);
  }

  @Public({
    operationId: 'AUTH-05',
    rule: 'Per-IP limit; the refresh token is the credential and works once, a second use ends the session (API design 10.3)',
  })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Body() body: RefreshTokenDto): Promise<ApiResult<RefreshResult>> {
    return ApiResult.ok(await this.sessions.refresh(body.refreshToken), AuthCode.REFRESH_OK);
  }

  @Policy({
    roles: [
      RoleCode.SocietyOwner,
      RoleCode.InstitutionAdmin,
      RoleCode.TeacherStaff,
      RoleCode.StudentParent,
    ],
    scope: 'self',
    allowNoContext: true,
    operationId: 'AUTH-06',
    rule: 'Mobile sessions only; the person must hold the grant, staff record or guardian link for the role (API design 10.4)',
  })
  @HttpCode(HttpStatus.OK)
  @Post('context')
  async switchContext(
    @CurrentPrincipal() principal: Principal,
    @Body() body: SwitchContextDto,
  ): Promise<ApiResult<SwitchResult>> {
    return ApiResult.ok(
      await this.contexts.switchContext(principal, body),
      AuthCode.CONTEXT_SWITCHED,
    );
  }

  @Policy({
    roles: ALL_ROLES,
    scope: 'self',
    allowNoContext: true,
    operationId: 'AUTH-07',
    rule: "Ends the caller's own session",
  })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@CurrentPrincipal() principal: Principal): Promise<ApiResult<null>> {
    await this.sessions.logout(principal);
    return ApiResult.ok(null, AuthCode.LOGOUT_OK);
  }

  @Policy({
    roles: ALL_ROLES,
    scope: 'self',
    allowNoContext: true,
    operationId: 'AUTH-08',
    rule: 'Ends every session of the caller',
  })
  @HttpCode(HttpStatus.OK)
  @Post('logout-all')
  async logoutAll(@CurrentPrincipal() principal: Principal): Promise<ApiResult<null>> {
    await this.sessions.logoutAll(principal);
    return ApiResult.ok(null, AuthCode.LOGOUT_ALL_OK);
  }
}
