import './bootstrap/load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap/configure-app.js';
import { EnvelopeExpressAdapter } from './bootstrap/http-adapter.js';
import { setupOpenApi } from './bootstrap/openapi.js';
import { AppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new EnvelopeExpressAdapter(),
    {
      bufferLogs: true,
      bodyParser: false,
    },
  );
  app.useLogger(app.get(Logger));
  configureApp(app);
  const { env } = app.get(AppConfig);
  if (env.OPENAPI_UI) setupOpenApi(app);
  await app.listen(env.PORT);
}

await bootstrap();
