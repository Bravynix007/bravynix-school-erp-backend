import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Principal } from '../../common/auth/access-token-verifier.js';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator.js';
import { Policy, Public } from '../../common/auth/policy.decorator.js';
import { ALL_ROLES, RoleCode } from '../../common/auth/roles.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AppException } from '../../common/http/app-exception.js';
import { AuthCode } from './auth-codes.js';
import {
  clearRefreshCookie,
  readRefreshCookie,
  requireConsoleHeader,
  setRefreshCookie,
} from './console-cookie.js';
import { LoginService, type MfaRequired } from './login.service.js';
import type { LoginResult } from './login-result.js';
import { MfaService, type MfaEnrolment } from './mfa.service.js';
import { OtpService } from './otp.service.js';
import { OTP_LIMITS } from './otp-limits.js';
import { ContextService, type SwitchResult } from './context.service.js';
import { EnrolMfaDto, VerifyMfaDto } from './mfa.dto.js';
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
    private readonly mfa: MfaService,
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
  async verifyCode(@Body() body: VerifyOtpDto): Promise<ApiResult<LoginResult | MfaRequired>> {
    const result = await this.login.verify(body);
    return 'mfaRequired' in result
      ? ApiResult.ok(result, AuthCode.MFA_REQUIRED)
      : ApiResult.ok(result, AuthCode.LOGIN_OK);
  }

  @Public({
    operationId: 'AUTH-03',
    rule: 'Per-IP limit; the mfaToken from AUTH-02 is the credential; a Super Admin who has not confirmed an authenticator (API design 10.2a)',
  })
  @HttpCode(HttpStatus.OK)
  @Post('mfa/enrol')
  async enrolMfa(@Body() body: EnrolMfaDto): Promise<ApiResult<MfaEnrolment>> {
    return ApiResult.ok(await this.mfa.enrol(body.mfaToken), AuthCode.MFA_SETUP_STARTED);
  }

  @Public({
    operationId: 'AUTH-04',
    rule: 'Per-IP limit; the mfaToken from AUTH-02 is the credential, 5 wrong codes kill it, a code works once (API design 10.2b)',
  })
  @HttpCode(HttpStatus.OK)
  @Post('mfa/verify')
  async verifyMfa(
    @Body() body: VerifyMfaDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResult<LoginResult>> {
    const login = await this.mfa.verify(body.mfaToken, body.code);
    setRefreshCookie(res, login.refreshCookie);
    return ApiResult.ok(login.result, AuthCode.LOGIN_OK);
  }

  @Public({
    operationId: 'AUTH-05',
    rule: 'Per-IP limit; the refresh token is the credential and works once, a second use ends the session (API design 10.3). Mobile sends it in the body; the console sends its cookie and X-Requested-With',
  })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Body() body: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResult<RenewedBody>> {
    if (typeof body.refreshToken === 'string') {
      const renewed = await this.sessions.refresh(body.refreshToken, 'mobile');
      return ApiResult.ok(renewedBody(renewed, renewed.refreshToken), AuthCode.REFRESH_OK);
    }

    requireConsoleHeader(req);
    const cookie = readRefreshCookie(req);
    if (cookie === undefined) throw AppException.unauthorized(AuthCode.REFRESH_TOKEN_INVALID);
    try {
      const renewed = await this.sessions.refresh(cookie, 'console');
      setRefreshCookie(res, renewed.refreshCookie);
      return ApiResult.ok(renewedBody(renewed, null), AuthCode.REFRESH_OK);
    } catch (error) {
      // A cookie that is refused is no use again; one refused for a busy server is kept.
      if (error instanceof AppException && error.status === HttpStatus.UNAUTHORIZED) {
        clearRefreshCookie(res);
      }
      throw error;
    }
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
    allowWhenPaused: true,
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
    allowWhenPaused: true,
    operationId: 'AUTH-07',
    rule: "Ends the caller's own session",
  })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResult<null>> {
    guardConsole(principal, req, res);
    await this.sessions.logout(principal);
    return ApiResult.ok(null, AuthCode.LOGOUT_OK);
  }

  @Policy({
    roles: ALL_ROLES,
    scope: 'self',
    allowNoContext: true,
    allowWhenPaused: true,
    operationId: 'AUTH-08',
    rule: 'Ends every session of the caller',
  })
  @HttpCode(HttpStatus.OK)
  @Post('logout-all')
  async logoutAll(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResult<null>> {
    guardConsole(principal, req, res);
    await this.sessions.logoutAll(principal);
    return ApiResult.ok(null, AuthCode.LOGOUT_ALL_OK);
  }
}

/** A console session ends only on a call that carries the console header, and its cookie goes with it. */
function guardConsole(principal: Principal, req: Request, res: Response): void {
  if (principal.clientType !== 'console') return;
  requireConsoleHeader(req);
  clearRefreshCookie(res);
}

interface RenewedBody {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string | null;
}

/** What AUTH-05 answers: the new refresh token in the body on mobile, `null` on the console (it is in the cookie). */
function renewedBody(renewed: RefreshResult, refreshToken: string | null): RenewedBody {
  return {
    accessToken: renewed.accessToken,
    accessTokenExpiresAt: renewed.accessTokenExpiresAt,
    refreshToken,
  };
}
