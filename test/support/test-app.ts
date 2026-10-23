import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap/configure-app.js';
import { EnvelopeExpressAdapter } from '../../src/bootstrap/http-adapter.js';
import { AccessTokenVerifier } from '../../src/common/auth/access-token-verifier.js';
import { Clock, FixedClock } from '../../src/common/time/clock.js';
import { EmailSender } from '../../src/platform/email/email-sender.js';
import { InMemoryEmailSender } from '../../src/platform/email/in-memory-email-sender.js';

export interface TestApp {
  app: NestExpressApplication;
  clock: FixedClock;
  email: InMemoryEmailSender;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Extra modules, e.g. test-only controllers. */
  imports?: Type<unknown>[];
  /** Replaces the access token verifier (phase 1 tests use the real one). */
  verifier?: AccessTokenVerifier;
  clockStart?: string;
}

/**
 * The real app with a controllable clock and an in-memory email sink, wired
 * through the same `configureApp` as production.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const clock = new FixedClock(options.clockStart);
  const email = new InMemoryEmailSender(clock);
  let builder = Test.createTestingModule({ imports: [AppModule, ...(options.imports ?? [])] })
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(EmailSender)
    .useValue(email);
  if (options.verifier) {
    builder = builder.overrideProvider(AccessTokenVerifier).useValue(options.verifier);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(
    new EnvelopeExpressAdapter(),
    {
      bodyParser: false,
      bufferLogs: true,
    },
  );
  // Logs follow LOG_LEVEL (silent by default in tests).
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.init();
  return { app, clock, email, close: () => app.close() };
}
