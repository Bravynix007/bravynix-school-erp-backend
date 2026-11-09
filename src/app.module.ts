import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { CommonModule } from './common/common.module.js';
import { JsonBodyModule } from './common/http/json-body.module.js';
import { LogDestination, LogDestinationModule } from './common/logging/log-destination.js';
import { requestLogProps, serializeRequest } from './common/logging/request-log.js';
import { AppConfig, AppConfigModule } from './config/app-config.js';
import { HealthModule } from './health/health.module.js';
import { AcademicSetupModule } from './modules/academic-setup/index.js';
import { PeopleModule } from './modules/people/index.js';
import { PlatformBillingModule } from './modules/platform-billing/index.js';
import { PlatformDashboardModule } from './modules/platform-dashboard/index.js';
import { AuditModule } from './platform/audit/audit.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { EmailModule } from './platform/email/email.module.js';
import { FilesModule } from './platform/files/index.js';
import { IdentityNumbersModule } from './platform/identity-numbers/index.js';
import { IdempotencyModule } from './platform/idempotency/idempotency.module.js';
import { IdentityModule } from './platform/identity/identity.module.js';
import { MastersModule } from './platform/masters/index.js';
import { NumberingModule } from './platform/numbering/numbering.module.js';
import { TenancyModule } from './platform/tenancy/tenancy.module.js';

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
    IdentityModule,
    TenancyModule,
    MastersModule,
    IdempotencyModule,
    NumberingModule,
    FilesModule,
    IdentityNumbersModule,
    HealthModule,
    // Platform modules (Notifications, Jobs) are registered here as they are built.
    // Business modules are registered here as they are built.
    AcademicSetupModule,
    PeopleModule,
    PlatformBillingModule,
    PlatformDashboardModule,
  ],
})
export class AppModule {}
