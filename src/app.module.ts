import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { CommonModule } from './common/common.module.js';
import { JsonBodyModule } from './common/http/json-body.module.js';
import { LogDestination, LogDestinationModule } from './common/logging/log-destination.js';
import { requestLogProps, serializeRequest } from './common/logging/request-log.js';
import { AppConfig, AppConfigModule } from './config/app-config.js';
import { HealthModule } from './health/health.module.js';
import { AuditModule } from './platform/audit/audit.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { EmailModule } from './platform/email/email.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      imports: [LogDestinationModule],
      inject: [AppConfig, LogDestination],
      useFactory: ({ env }: AppConfig, destination: LogDestination) => {
        const options: Options = {
          level: destination.level ?? env.LOG_LEVEL,
          // The request ID middleware has already set req.id.
          genReqId: (req) => (req as { id?: string }).id ?? '',
          // Log the route template and outcome, never the URL, headers or
          // bodies (API design 20.2).
          serializers: {
            req: serializeRequest,
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          customProps: requestLogProps,
          // A 5xx is an error to look at; the exception filter has already
          // logged its cause with the same request ID. A client that hung up,
          // common on mobile networks, is only a warning.
          customLogLevel: (_req, res, error) =>
            res.statusCode >= 500 ? 'error' : error ? 'warn' : 'info',
          // Never log tokens, cookies or bodies (SDD 17.1, QA strategy 4).
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body',
            ],
            censor: '[redacted]',
          },
          autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health/') },
          transport:
            env.NODE_ENV === 'development' && !destination.stream
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        };
        return { pinoHttp: destination.stream ? [options, destination.stream] : options };
      },
    }),
    CommonModule,
    JsonBodyModule,
    DatabaseModule,
    EmailModule,
    AuditModule,
    HealthModule,
    // Platform modules (Identity, Tenancy, Files, Notifications, Jobs)
    // and business modules are registered here as they are built.
  ],
})
export class AppModule {}
