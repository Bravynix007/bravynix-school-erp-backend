import { Injectable } from '@nestjs/common';

/** A job as the worker claimed it. */
export interface ClaimedJob {
  id: string;
  kind: string;
  societyId: string;
  /** Empty for work of the whole Society. */
  institutionId: string | null;
  /** The person whose request made the job, when there was one. */
  startedBy: string | null;
  payload: unknown;
  /** How many times the job has been claimed, this time included. */
  attempts: number;
}

/** A handler's hold on its job. */
export interface JobLease {
  /**
   * Renews the lease; a handler calls it between steps. Throws `JobLeaseLost` when another worker has taken the job
   * over, which means this one must stop at once.
   */
  keep(): Promise<void>;
}

/** The lease ran out and another worker took the job: the one that lost it stops without settling anything. */
export class JobLeaseLost extends Error {
  constructor() {
    super('The job lease was lost');
    this.name = 'JobLeaseLost';
  }
}

/** The work of one kind of job. A module registers its handlers with `JobRegistry`. */
export interface JobHandler {
  readonly kind: string;
  /** Does the work and resolves when it is finished. A run that is claimed again resumes; it never repeats a step. */
  run(job: ClaimedJob, lease: JobLease): Promise<void>;
  /** The job is failed for good (an error with no attempts left, or too many claims): settle the record it served. */
  fail(job: ClaimedJob, reason: string): Promise<void>;
}

/** Who handles which kind of job. */
@Injectable()
export class JobRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.kind)) {
      throw new Error(`A handler for the job kind ${handler.kind} is already registered`);
    }
    this.handlers.set(handler.kind, handler);
  }

  handlerFor(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }
}
