import { Injectable, Logger } from '@nestjs/common';
import { EmailSender, type EmailMessage } from './email-sender.js';

/**
 * Logs that a message would be sent, with the template name only. The body
 * is never logged, because it can hold an OTP (QA strategy 4).
 */
@Injectable()
export class LogEmailSender extends EmailSender {
  private readonly logger = new Logger('Email');

  send(message: EmailMessage): Promise<void> {
    this.logger.log({ template: message.template }, 'Email not sent (EMAIL_DRIVER=log)');
    return Promise.resolve();
  }
}
