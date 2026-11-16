import { Module } from '@nestjs/common';
import { FilesModule } from '../files/index.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { SweepsRepository } from './sweeps.repository.js';
import { SweepsRunner } from './sweeps.runner.js';
import { SweepsService } from './sweeps.service.js';

/** The worker's clean-up sweeps (DDD 16.3, 16.4). The API never runs them; `npm run worker` does. */
@Module({
  imports: [FilesModule, IdempotencyModule],
  providers: [SweepsRepository, SweepsService, SweepsRunner],
  exports: [SweepsRunner, SweepsService],
})
export class SweepsModule {}
