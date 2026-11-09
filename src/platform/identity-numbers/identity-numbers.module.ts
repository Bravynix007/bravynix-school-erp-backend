import { Global, Module } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app-config.js';
import { AuditService } from '../audit/index.js';
import { SecretBox } from '../crypto/index.js';
import { IdentityNumbers } from './identity-numbers.service.js';

@Global()
@Module({
  providers: [
    {
      provide: IdentityNumbers,
      inject: [AppConfig, AuditService, Clock],
      useFactory: ({ env }: AppConfig, audit: AuditService, clock: Clock) =>
        new IdentityNumbers(
          new SecretBox(env.IDENTITY_ENCRYPTION_KEY, 'IDENTITY_ENCRYPTION_KEY'),
          Buffer.from(env.IDENTITY_HMAC_KEY, 'base64'),
          audit,
          clock,
        ),
    },
  ],
  exports: [IdentityNumbers],
})
export class IdentityNumbersModule {}
