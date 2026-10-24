import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { jsonBodyMiddleware } from './json-body.middleware.js';

/**
 * Parses JSON bodies (1 MB, API design 7.4) as module middleware instead of
 * with `app.use`, so it runs after the request logger: Nest applies a global
 * module's middleware, such as nestjs-pino's LoggerModule, before a plain
 * module's. A body the parser refuses (malformed, too large, too deep, not
 * UTF-8) still gets its one log line (API design 20.2).
 */
@Module({})
export class JsonBodyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(jsonBodyMiddleware('1mb'))
      .forRoutes({ path: '{/*splat}', method: RequestMethod.ALL });
  }
}
