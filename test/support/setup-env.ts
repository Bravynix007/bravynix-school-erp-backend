// Test defaults. Real values from the shell or CI win.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.EMAIL_DRIVER = 'memory';
process.env.TEST_DATABASE_URL ??= 'postgres://erp_app:erp_app@localhost:5432/school_erp_test';
process.env.TEST_DATABASE_MIGRATION_URL ??=
  'postgres://erp_migrator:erp_migrator@localhost:5432/school_erp_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_MIGRATION_URL = process.env.TEST_DATABASE_MIGRATION_URL;
process.env.CORS_ORIGINS ??= 'http://localhost:3001';
// A fixed fake secret, for tests only. Real deployments set their own (>= 32 characters).
process.env.OTP_HMAC_SECRET ??= 'test-only-secret-not-used-anywhere-else-0123456789';
// A fixed fake key (32 zero-ish bytes), for tests only, so a secret sealed by one app instance opens in the next.
process.env.MFA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.OTP_DEV_ECHO = 'false';
