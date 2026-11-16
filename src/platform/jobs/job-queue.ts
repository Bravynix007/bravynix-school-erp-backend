import { Injectable } from '@nestjs/common';
import { newId } from '../../common/ids/ids.js';
import type { Tx } from '../database/index.js';
import { JobsRepository } from './jobs.repository.js';

/** What a module asks the worker to do. */
export interface JobRequest {
  kind: string;
  societyId: string;
  institutionId: string | null;
  startedBy: string | null;
  /** What the handler needs to find its work: IDs and settings, never personal data. */
  payload: object;
}

/** Where a module asks for background work. The job is queued in the transaction of the change that asks for it. */
@Injectable()
export class JobQueue {
  constructor(private readonly jobs: JobsRepository) {}

  /** Queues the job and returns its ID; it exists only if the caller's transaction commits. */
  async enqueue(tx: Tx, request: JobRequest): Promise<string> {
    const id = newId();
    await this.jobs.insert(tx, {
      id,
      kind: request.kind,
      societyId: request.societyId,
      institutionId: request.institutionId,
      createdBy: request.startedBy,
      payload: request.payload,
    });
    return id;
  }
}
