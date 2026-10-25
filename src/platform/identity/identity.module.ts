import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { AuthController } from './auth.controller.js';
import { IdentityRepository } from './identity.repository.js';
import { LoginService } from './login.service.js';
import { OtpHasher } from './otp-hasher.js';
import { OtpService } from './otp.service.js';
import { PublicCallLimiter } from './public-call-limiter.js';
import { SessionRepository } from './session.repository.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    IdentityRepository,
    SessionRepository,
    LoginService,
    OtpService,
    PublicCallLimiter,
    {
      provide: TokenService,
      inject: [AppConfig],
      // The refresh-token hash shares the login secret; the domains are separate ("refresh:" vs "otp:", "email:").
      useFactory: ({ env }: AppConfig) =>
        new TokenService(env.JWT_SIGNING_KEY, env.JWT_KEY_ID, env.OTP_HMAC_SECRET),
    },
    {
      provide: OtpHasher,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) => new OtpHasher(env.OTP_HMAC_SECRET),
    },
  ],
  exports: [OtpService, PublicCallLimiter, TokenService],
})
export class IdentityModule {}
