import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DatabaseService, type TenantContext } from '../database/index.js';
import { JobRegistry, type ClaimedJob, type JobHandler, type JobLease } from '../jobs/index.js';
import { NotificationsRepository } from './notifications.repository.js';
import {
  FANOUT_BATCH,
  NOTIFY_JOB,
  noticeOfPayload,
  type NoticePayload,
} from './notifications.rules.js';
import { PushSender, type PushMessage } from './push-sender.js';

/**
 * The worker side of a notice (SDD 11.2): writes it to each receiver's inbox 200 at a time, and sends the push to the
 * phones of the people whose row it added. A job that is claimed again (the worker died, or it stopped on a passing
 * fault) writes no row twice and sends no push twice for a row it already wrote; a push that was never sent because
 * the worker died between the row and the push is not sent later, which a missed push costs less than a repeated one.
 * A push that cannot be sent never fails the job: the inbox is the notice, and the push only points to it.
 */
@Injectable()
export class NotifyProcessor implements JobHandler, OnModuleInit {
  readonly kind = NOTIFY_JOB;
  private readonly logger = new Logger(NotifyProcessor.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: NotificationsRepository,
    private readonly sender: PushSender,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(job: ClaimedJob, lease: JobLease): Promise<void> {
    const notice = noticeOfPayload(job.payload);
    const tenant: TenantContext = {
      societyId: job.societyId,
      institutionIds: job.institutionId ? [job.institutionId] : [],
    };
    for (let from = 0; from < notice.receivers.length; from += FANOUT_BATCH) {
      await lease.keep();
      const receivers = notice.receivers.slice(from, from + FANOUT_BATCH);
      const delivered = await this.database.transaction(tenant, (tx) =>
        this.repository.deliver(tx, {
          ...notice,
          societyId: job.societyId,
          institutionId: job.institutionId,
          receivers,
        }),
      );
      await this.push(tenant, notice, delivered);
    }
  }

  /** Nothing is left to settle: a notice that could not be written has no record but the job. */
  fail(job: ClaimedJob, reason: string): Promise<void> {
    this.logger.error({ jobId: job.id, reason }, 'A notice could not be delivered');
    return Promise.resolve();
  }

  private async push(
    tenant: TenantContext,
    notice: NoticePayload,
    receivers: string[],
  ): Promise<void> {
    try {
      const devices = await this.database.transaction(tenant, (tx) =>
        this.repository.devicesOf(tx, receivers),
      );
      if (devices.length === 0) return;
      const messages: PushMessage[] = devices.map((device) => ({
        token: device.fcm_token,
        platform: device.platform,
        language: device.app_language,
        title: notice.title,
        body: notice.body,
      }));
      const outcomes = await this.sender.send(messages);
      const invalid = messages
        .filter((_message, index) => outcomes[index] === 'invalid_token')
        .map((message) => message.token);
      await this.database.transaction(tenant, (tx) => this.repository.removeDevices(tx, invalid));
    } catch (error) {
      this.logger.warn({ err: error }, 'The push of a notice could not be sent');
    }
  }
}
