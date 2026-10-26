import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { AuthController } from './auth.controller.js';
import { IdentityRepository } from './identity.repository.js';
import { OtpHasher } from './otp-hasher.js';
import { OtpService } from './otp.service.js';
import { PublicCallLimiter } from './public-call-limiter.js';

@Module({
  controllers: [AuthController],
  providers: [
    IdentityRepository,
    OtpService,
    PublicCallLimiter,
    {
      provide: OtpHasher,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) => new OtpHasher(env.OTP_HMAC_SECRET),
    },
  ],
  exports: [OtpService, PublicCallLimiter],
})
export class IdentityModule {}
