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

/** `no-reply@example.in` or `Display Name <no-reply@example.in>`. */
const SENDER = /^(?:[^<>@]+ <[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}>|[^\s<>@]+@[^\s<>@]+\.[a-z]{2,})$/i;

const semver = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must look like 1.4.2')
  .optional();

/** A 32-byte key, base64 encoded (`openssl rand -base64 32`). */
const base64Key32 = z
  .string()
  .refine((key) => Buffer.from(key, 'base64').length === 32, '32 bytes, base64 encoded');

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

    /**
     * Secret for the keyed hashes of emails and login codes (SDD 13.2), at
     * least 32 characters. Required in staging and production; elsewhere a
     * random one is made at start, so codes do not survive a restart.
     */
    OTP_HMAC_SECRET: z.string().min(32).optional(),
    /**
     * The ES256 private key (PKCS#8 PEM, `\n` accepted for line breaks) that
     * signs access tokens (SDD 13.2). Required in staging and production,
     * where it comes from Secrets Manager; elsewhere a key is made at start, so
     * tokens do not survive a restart.
     */
    JWT_SIGNING_KEY: z.string().min(1).optional(),
    /**
     * 32 random bytes, base64: encrypts Super Admin authenticator secrets at
     * rest (AES-256-GCM, DDD 15.6). Required in staging and production, from
     * Secrets Manager; elsewhere a key is made at start, so enrolled
     * authenticators do not survive a restart.
     */
    MFA_ENCRYPTION_KEY: base64Key32.optional(),
    /**
     * 32 random bytes, base64: encrypts the Aadhaar numbers of staff and students at rest (AES-256-GCM, DDD 15.6).
     * Required everywhere and never made at start: a number sealed with a key that is gone cannot be read again.
     * Losing it loses every stored number, so it is backed up like the database.
     */
    IDENTITY_ENCRYPTION_KEY: base64Key32,
    /**
     * 32 random bytes, base64: the key of the keyed hash that finds a second record for the same Aadhaar
     * (DDD 15.6). Required everywhere and separate from the encryption key; changing it breaks duplicate checks.
     */
    IDENTITY_HMAC_KEY: base64Key32,
    /** Names the signing key in the token header, so a rotated key can be told apart. */
    JWT_KEY_ID: z.string().min(1).max(40).default('k1'),
    /**
     * Development only: a login code request for a registered account also
     * returns the code, so the app can be tried without a mail server. The
     * process refuses to start with it on in staging or production.
     */
    OTP_DEV_ECHO: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    /**
     * Where files are kept (API design 15). `local` is the server's own disk, for development, tests and the demo;
     * staging and production refuse it. `r2` (Cloudflare R2, decision of 8 Nov 2026) names the production store;
     * its driver arrives with the deployment slice, and the Files module refuses to start with it until then.
     */
    STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
    /**
     * Where the local file store keeps uploads (development, tests and the demo; API design 15). The real store
     * (R2) arrives with the deployment slice.
     */
    STORAGE_LOCAL_DIR: z.string().min(1).default('.local-storage'),
    /** The address clients reach this API at, for the upload and download links the local store hands out. */
    STORAGE_LOCAL_BASE_URL: z.url().optional(),

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
    // SES rejects an @localhost or malformed sender, which would stop every
    // login code (B7).
    if (deployed && (!SENDER.test(env.EMAIL_FROM) || /@localhost>?$/i.test(env.EMAIL_FROM))) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM'],
        message: 'must be a verified sender address in staging and production',
      });
    }
    if (deployed && !env.OTP_HMAC_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_HMAC_SECRET'],
        message: 'is required in staging and production',
      });
    }
    if (deployed && !env.JWT_SIGNING_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SIGNING_KEY'],
        message: 'is required in staging and production',
      });
    }
    if (deployed && !env.MFA_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_ENCRYPTION_KEY'],
        message: 'is required in staging and production',
      });
    }
    if (env.IDENTITY_ENCRYPTION_KEY === env.IDENTITY_HMAC_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['IDENTITY_HMAC_KEY'],
        message: 'must differ from IDENTITY_ENCRYPTION_KEY: one key never does two jobs',
      });
    }
    if (deployed && env.STORAGE_DRIVER === 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message:
          'must not be local in staging and production: the server disk is lost on a restart',
      });
    }
    if (deployed && env.OTP_DEV_ECHO) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_DEV_ECHO'],
        message: 'must be false in staging and production',
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
