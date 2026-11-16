import { Injectable, Logger } from '@nestjs/common';
import { SweepsService } from './sweeps.service.js';
import { SWEEP_INTERVAL_MS } from './sweeps.rules.js';

/** Runs the sweep at the worker's start and every hour after, until it is told to stop. */
@Injectable()
export class SweepsRunner {
  private readonly logger = new Logger(SweepsRunner.name);

  constructor(private readonly sweeps: SweepsService) {}

  async runUntil(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.sweeps.sweep();
      } catch (error) {
        this.logger.error({ err: error }, 'A sweep stopped');
      }
      await pause(SWEEP_INTERVAL_MS, signal);
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
