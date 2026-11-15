import { Injectable, Logger } from '@nestjs/common';
import {
  JobLeaseLost,
  JobRegistry,
  type ClaimedJob,
  type JobHandler,
  type JobLease,
} from './job-handler.js';
import { JobsRepository } from './jobs.repository.js';
import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  POLL_MS,
  failureOf,
  retryDelaySeconds,
} from './jobs.rules.js';

const NO_HANDLER = 'NO_HANDLER';
const ATTEMPTS_EXHAUSTED = 'ATTEMPTS_EXHAUSTED';

/**
 * The worker's loop (SDD 11.2): claim the oldest due job, run its handler, settle it. A job whose worker died is
 * claimed again once its lease runs out, and its handler resumes; one that stopped on a passing fault is queued again
 * after a pause, and given up on after `MAX_ATTEMPTS` claims. The failure the job record keeps is a code, never the
 * error's text.
 */
@Injectable()
export class JobRunner {
  private readonly logger = new Logger(JobRunner.name);

  constructor(
    private readonly jobs: JobsRepository,
    private readonly registry: JobRegistry,
  ) {}

  /** Runs one job if one is due; false when there was none. */
  async runNext(): Promise<boolean> {
    const job = await this.jobs.claim(LEASE_SECONDS);
    if (!job) return false;
    const handler = this.registry.handlerFor(job.kind);
    if (!handler) {
      this.logger.error({ jobId: job.id, kind: job.kind }, 'No handler for this kind of job');
      await this.jobs.settle(job.id, false, NO_HANDLER);
    } else if (job.attempts > MAX_ATTEMPTS) {
      await this.giveUp(handler, job, ATTEMPTS_EXHAUSTED);
    } else {
      await this.run(handler, job);
    }
    return true;
  }

  /** Runs jobs until `signal` aborts: one after another while there are some, then a pause between looks. */
  async runUntil(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let ran = false;
      try {
        ran = await this.runNext();
      } catch (error) {
        // The database was out of reach: the job keeps its lease and is claimed again when it runs out.
        this.logger.warn({ err: error }, 'The worker could not reach the job queue');
      }
      if (!ran) await pause(POLL_MS, signal);
    }
  }

  private async run(handler: JobHandler, job: ClaimedJob): Promise<void> {
    const lease: JobLease = {
      keep: async () => {
        if (!(await this.jobs.extend(job.id, LEASE_SECONDS))) throw new JobLeaseLost();
      },
    };
    try {
      await handler.run(job, lease);
    } catch (error) {
      if (error instanceof JobLeaseLost) {
        this.logger.warn({ jobId: job.id, kind: job.kind }, 'Another worker took this job over');
        return;
      }
      const reason = failureOf(error);
      this.logger.error({ err: error, jobId: job.id, kind: job.kind }, 'A job stopped');
      if (job.attempts >= MAX_ATTEMPTS) await this.giveUp(handler, job, reason);
      else await this.jobs.retry(job.id, retryDelaySeconds(job.attempts), reason);
      return;
    }
    await this.jobs.settle(job.id, true, null);
  }

  private async giveUp(handler: JobHandler, job: ClaimedJob, reason: string): Promise<void> {
    try {
      await handler.fail(job, reason);
    } finally {
      await this.jobs.settle(job.id, false, reason);
    }
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
