import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { EmailSender, type EmailMessage } from '../email/email-sender.js';
import { withTimeout } from './with-timeout.js';

/** SES gets this long before the send is given up on (SDD 11.3). */
const SEND_TIMEOUT_MS = 3000;

/**
 * Sends a mail after the answer is decided, off the request, so the time taken
 * does not depend on the address. A failed or slow send is logged without the
 * address or the content and the answer is unchanged; a retry queue arrives
 * with the Jobs module.
 */
@Injectable()
export class BackgroundMailer implements OnModuleDestroy {
  private readonly logger = new Logger(BackgroundMailer.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly email: EmailSender) {}

  send(message: EmailMessage): void {
    const task = withTimeout(this.email.send(message), SEND_TIMEOUT_MS, 'EmailTimeout').catch(
      (error: unknown) => {
        this.logger.warn({
          msg: 'Email was not sent',
          template: message.template,
          // The name or our own timeout reason; an SMTP message can hold the address.
          error:
            error instanceof Error && error.message === 'EmailTimeout'
              ? 'EmailTimeout'
              : error instanceof Error
                ? error.name
                : 'unknown',
        });
      },
    );
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** Waits for mail still being sent. For tests and a clean shutdown. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.inFlight);
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
