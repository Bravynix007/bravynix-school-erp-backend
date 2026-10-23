import { Injectable } from '@nestjs/common';
import { Clock, SystemClock } from '../../common/time/clock.js';
import { EmailSender, type EmailMessage } from './email-sender.js';

export interface SentEmail extends EmailMessage {
  sentAt: Date;
}

/** Keeps sent mail in memory so tests can read it, e.g. the OTP a login sent. */
@Injectable()
export class InMemoryEmailSender extends EmailSender {
  private readonly outbox: SentEmail[] = [];

  constructor(private readonly clock: Clock = new SystemClock()) {
    super();
  }

  send(message: EmailMessage): Promise<void> {
    this.outbox.push({ ...message, sentAt: this.clock.now() });
    return Promise.resolve();
  }

  all(): readonly SentEmail[] {
    return this.outbox;
  }

  /** The newest message to `to`, optionally of one template. */
  latest(to: string, template?: string): SentEmail | undefined {
    const address = to.toLowerCase();
    return this.outbox
      .toReversed()
      .find((m) => m.to.toLowerCase() === address && (!template || m.template === template));
  }

  count(to?: string): number {
    if (!to) return this.outbox.length;
    return this.outbox.filter((m) => m.to.toLowerCase() === to.toLowerCase()).length;
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
