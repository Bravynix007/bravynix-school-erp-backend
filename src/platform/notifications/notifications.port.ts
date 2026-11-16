import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/index.js';
import { JobQueue } from '../jobs/index.js';
import { NOTIFY_JOB, checkNotice, payloadOfNotice, type Notice } from './notifications.rules.js';

/**
 * Where a module asks for a notice to reach people (SDD 9.3 rule 4). The ask is a job saved in the transaction of the
 * change that caused it, so the notice exists only if the change does; the worker writes the inbox rows and sends the
 * push (`NotifyProcessor`). The module names the receivers it has already worked out under its own rules.
 */
@Injectable()
export class Notifications {
  constructor(private readonly jobs: JobQueue) {}

  /** Queues the notice and returns its job's ID, or null when it has no receivers and there is nothing to send. */
  async notify(tx: Tx, notice: Notice, startedBy: string | null): Promise<string | null> {
    checkNotice(notice);
    const payload = payloadOfNotice(notice);
    if (payload.receivers.length === 0) return null;
    return this.jobs.enqueue(tx, {
      kind: NOTIFY_JOB,
      societyId: notice.societyId,
      institutionId: notice.institutionId,
      startedBy,
      payload,
    });
  }
}
