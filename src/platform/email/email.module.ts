import { Global, Module } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app-config.js';
import { EmailSender } from './email-sender.js';
import { InMemoryEmailSender } from './in-memory-email-sender.js';
import { LogEmailSender } from './log-email-sender.js';
import { SmtpEmailSender } from './smtp-email-sender.js';

@Global()
@Module({
  providers: [
    {
      provide: EmailSender,
      inject: [AppConfig, Clock],
      useFactory: ({ env }: AppConfig, clock: Clock): EmailSender => {
        switch (env.EMAIL_DRIVER) {
          case 'memory':
            return new InMemoryEmailSender(clock);
          case 'smtp':
            return new SmtpEmailSender(env.SMTP_URL!, env.EMAIL_FROM);
          default:
            return new LogEmailSender();
        }
      },
    },
  ],
  exports: [EmailSender],
})
export class EmailModule {}
