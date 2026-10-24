import { Module } from '@nestjs/common';
import type { DestinationStream, LevelWithSilent } from 'pino';

/**
 * Where log lines go. Deployed apps write to stdout; tests hand in a stream
 * so they can read the real request log lines back (API design 20.2).
 */
export class LogDestination {
  constructor(
    readonly stream?: DestinationStream,
    /** Overrides LOG_LEVEL, so one test can read lines while the rest stay silent. */
    readonly level?: LevelWithSilent,
  ) {}
}

@Module({
  providers: [{ provide: LogDestination, useValue: new LogDestination() }],
  exports: [LogDestination],
})
export class LogDestinationModule {}
