import { parseEnv } from './env.schema.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('parseEnv', () => {
  it('applies defaults', () => {
    const env = parseEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.EMAIL_DRIVER).toBe('log');
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.OPENAPI_UI).toBe(false);
  });

  it('splits CORS origins', () => {
    const env = parseEnv({ ...base, CORS_ORIGINS: 'https://a.test, https://b.test,' });
    expect(env.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
  });

  it('refuses to start without a database URL', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('needs SMTP_URL for the smtp driver', () => {
    expect(() => parseEnv({ ...base, EMAIL_DRIVER: 'smtp' })).toThrow(/SMTP_URL/);
  });

  it('refuses the memory and log email drivers when deployed', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', EMAIL_DRIVER: 'memory' })).toThrow(
      /EMAIL_DRIVER/,
    );
    expect(() => parseEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/EMAIL_DRIVER/);
  });

  it('refuses the OpenAPI UI in production', () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        EMAIL_DRIVER: 'smtp',
        SMTP_URL: 'smtp://x',
        OPENAPI_UI: 'true',
      }),
    ).toThrow(/OPENAPI_UI/);
  });

  it('needs a real sender address when deployed', () => {
    const deployed = { ...base, NODE_ENV: 'staging', EMAIL_DRIVER: 'smtp', SMTP_URL: 'smtp://x' };
    expect(() => parseEnv(deployed)).toThrow(/EMAIL_FROM/);
    expect(
      parseEnv({ ...deployed, EMAIL_FROM: 'BravyNix <no-reply@bravynix.in>' }).EMAIL_FROM,
    ).toBe('BravyNix <no-reply@bravynix.in>');
  });

  it('validates minimum app versions', () => {
    expect(() => parseEnv({ ...base, MIN_APP_VERSION_IOS: '1.2' })).toThrow(/MIN_APP_VERSION_IOS/);
    expect(parseEnv({ ...base, MIN_APP_VERSION_IOS: '1.2.0' }).MIN_APP_VERSION_IOS).toBe('1.2.0');
  });
});
