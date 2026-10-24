import { RequestMethod, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { requestIdMiddleware } from '../common/request-context/request-id.middleware.js';
import { AppConfig } from '../config/app-config.js';
import { API_PREFIX, UNPREFIXED_PATHS } from './routes.js';

/**
 * Everything `main.ts` and the e2e tests both need, so tests run the same
 * HTTP stack as production.
 */
export function configureApp(app: NestExpressApplication): INestApplication {
  const { env } = app.get(AppConfig);

  app.use(requestIdMiddleware);
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // The API serves JSON only; the console sets its own CSP.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      frameguard: { action: 'deny' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Accept-Language',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Requested-With',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });
  // JSON bodies are parsed by JsonBodyModule, after the request logger.
  app.setGlobalPrefix(API_PREFIX, {
    exclude: UNPREFIXED_PATHS.map((path) => ({ path, method: RequestMethod.GET })),
  });
  app.enableShutdownHooks();
  return app;
}
