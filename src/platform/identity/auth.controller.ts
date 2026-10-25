import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/policy.decorator.js';
import { ApiResult } from '../../common/http/api-result.js';
import { AuthCode } from './auth-codes.js';
import { OtpService } from './otp.service.js';
import { OTP_LIMITS } from './otp-limits.js';
import { RequestOtpDto } from './request-otp.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly otp: OtpService) {}

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
}
