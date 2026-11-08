import '../bootstrap/load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module.js';
import { configureApp } from '../bootstrap/configure-app.js';

/**
 * Builds the app without listening, for CLIs that read its routes. The
 * database pool connects lazily, so no database is needed, and no data is
 * read or written, so the keys that protect stored data are placeholders.
 */
export async function createCliApp(): Promise<NestExpressApplication> {
  process.env.DATABASE_URL ??= 'postgres://cli:cli@localhost:5432/cli';
  process.env.IDENTITY_ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString('base64');
  process.env.IDENTITY_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
  process.env.LOG_LEVEL = 'silent';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
  return app;
}
