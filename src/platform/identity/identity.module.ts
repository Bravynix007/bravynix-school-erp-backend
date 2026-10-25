import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { AuthController } from './auth.controller.js';
import { IdentityRepository } from './identity.repository.js';
import { OtpHasher } from './otp-hasher.js';
import { OtpService } from './otp.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    IdentityRepository,
    OtpService,
    {
      provide: OtpHasher,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) => new OtpHasher(env.OTP_HMAC_SECRET),
    },
  ],
  exports: [OtpService],
})
export class IdentityModule {}
