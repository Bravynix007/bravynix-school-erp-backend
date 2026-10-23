import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { CommonModule } from './common/common.module.js';
import { RequestContext } from './common/request-context/request-context.js';
import { AppConfig, AppConfigModule } from './config/app-config.js';
import { HealthModule } from './health/health.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { EmailModule } from './platform/email/email.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          // The request ID middleware has already set req.id.
          genReqId: (req) => (req as { id?: string }).id ?? '',
          // Log the request line and outcome, never headers or bodies.
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          customProps: () => {
            const ctx = RequestContext.current();
            return {
              personId: ctx?.personId,
              societyId: ctx?.societyId,
              roleCode: ctx?.roleCode,
            };
          },
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
            env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    CommonModule,
    DatabaseModule,
    EmailModule,
    HealthModule,
    // Platform modules (Identity, Tenancy, Audit, Files, Notifications, Jobs)
    // and business modules are registered here as they are built.
  ],
})
export class AppModule {}
