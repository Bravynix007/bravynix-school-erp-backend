import './bootstrap/load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { JobRunner } from './platform/jobs/index.js';
import { SweepsRunner } from './platform/sweeps/index.js';

/**
 * The background worker (SDD 11.2, plan decision 5): the same code base as the API, started apart from it. It listens
 * on no port; it takes jobs from the queue and sweeps what is past its keeping, hourly, until it is told to stop, and
 * finishes the job in hand first.
 */
async function work(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  await Promise.all([
    app.get(JobRunner).runUntil(stop.signal),
    app.get(SweepsRunner).runUntil(stop.signal),
  ]);
  await app.close();
}

await work();
