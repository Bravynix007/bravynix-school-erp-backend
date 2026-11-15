import { Module } from '@nestjs/common';
import { JobQueue } from './job-queue.js';
import { JobRegistry } from './job-handler.js';
import { JobRunner } from './job-runner.js';
import { JobsRepository } from './jobs.repository.js';

/** The job queue and the worker's loop (SDD 11.2). The API only queues; `npm run worker` runs. */
@Module({
  providers: [JobsRepository, JobQueue, JobRegistry, JobRunner],
  exports: [JobQueue, JobRegistry, JobRunner],
})
export class JobsModule {}
