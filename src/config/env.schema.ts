import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const semver = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must look like 1.4.2')
  .optional();

/**
 * Every environment variable the API reads. The process refuses to start when
 * one is missing or malformed, so a bad deploy fails at boot, not at the first
 * request that needs the value.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Express "trust proxy" hops; 1 behind the AWS load balancer. */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    /** Connection for the app's own user (DML only, subject to row-level security). */
    DATABASE_URL: z.url(),
    /** Connection for the migration user, which owns the schema. Falls back to DATABASE_URL. */
    DATABASE_MIGRATION_URL: z.url().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /** Statement timeout in ms (API design 13.3). */
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),

    /** Origins allowed to call the API from a browser (the Super Admin console). */
    CORS_ORIGINS: csv,

    EMAIL_DRIVER: z.enum(['memory', 'log', 'smtp']).default('log'),
    /** smtp://user:pass@host:port, for Mailpit locally or the SES SMTP endpoint. */
    SMTP_URL: z.string().optional(),
    EMAIL_FROM: z.string().default('BravyNix School ERP <no-reply@localhost>'),

    /** Below these app versions the API answers 426 APP_UPDATE_REQUIRED (API design 5.2). */
    MIN_APP_VERSION_ANDROID: semver,
    MIN_APP_VERSION_IOS: semver,
    PLAY_STORE_URL: z.url().optional(),
    APP_STORE_URL: z.url().optional(),

    /** Serve the OpenAPI document at /docs. Never on in production. */
    OPENAPI_UI: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_DRIVER === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'is required when EMAIL_DRIVER=smtp',
      });
    }
    const deployed = env.NODE_ENV === 'staging' || env.NODE_ENV === 'production';
    if (deployed && env.EMAIL_DRIVER !== 'smtp') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_DRIVER'],
        message: 'must be smtp in staging and production',
      });
    }
    // SES rejects an @localhost sender, which would stop every login code (B7).
    if (deployed && /@localhost>?$/i.test(env.EMAIL_FROM)) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM'],
        message: 'must be a verified sender address in staging and production',
      });
    }
    if (env.NODE_ENV === 'production' && env.OPENAPI_UI) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAPI_UI'],
        message: 'must be false in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
