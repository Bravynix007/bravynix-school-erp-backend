import { readFileSync } from 'node:fs';
import { parseEnv, PUBLISHED_IDENTITY_KEYS } from './env.schema.js';

const ENCRYPTION = Buffer.alloc(32, 3).toString('base64');
const HMAC = Buffer.alloc(32, 5).toString('base64');
const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  IDENTITY_ENCRYPTION_KEY: ENCRYPTION,
  IDENTITY_HMAC_KEY: HMAC,
};
const SECRET = 'unit-test-secret-not-used-anywhere-0123456789';
const KEY = Buffer.alloc(32, 9).toString('base64');

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
    const deployed = {
      ...base,
      NODE_ENV: 'staging',
      EMAIL_DRIVER: 'smtp',
      STORAGE_DRIVER: 'r2',
      SMTP_URL: 'smtp://x',
      OTP_HMAC_SECRET: SECRET,
      JWT_SIGNING_KEY: 'pem',
      MFA_ENCRYPTION_KEY: KEY,
    };
    expect(() => parseEnv(deployed)).toThrow(/EMAIL_FROM/);
    for (const bad of ['', 'no-reply', 'BravyNix <no-reply@bravynix>', 'a b@bravynix.in']) {
      expect(() => parseEnv({ ...deployed, EMAIL_FROM: bad })).toThrow(/EMAIL_FROM/);
    }
    for (const good of ['BravyNix <no-reply@bravynix.in>', 'no-reply@mail.bravynix.in']) {
      expect(parseEnv({ ...deployed, EMAIL_FROM: good }).EMAIL_FROM).toBe(good);
    }
  });

  it('refuses the local file store when deployed, and accepts the production one', () => {
    const deployed = {
      ...base,
      NODE_ENV: 'staging',
      EMAIL_DRIVER: 'smtp',
      SMTP_URL: 'smtp://x',
      EMAIL_FROM: 'BravyNix <no-reply@bravynix.in>',
      OTP_HMAC_SECRET: 'x'.repeat(32),
      JWT_SIGNING_KEY: 'pem',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    expect(parseEnv(base).STORAGE_DRIVER).toBe('local');
    for (const NODE_ENV of ['staging', 'production']) {
      expect(() => parseEnv({ ...deployed, NODE_ENV })).toThrow(/STORAGE_DRIVER/);
      expect(() => parseEnv({ ...deployed, NODE_ENV, STORAGE_DRIVER: 'local' })).toThrow(
        /STORAGE_DRIVER/,
      );
      expect(parseEnv({ ...deployed, NODE_ENV, STORAGE_DRIVER: 'r2' }).STORAGE_DRIVER).toBe('r2');
    }
    expect(() => parseEnv({ ...base, STORAGE_DRIVER: 's3' })).toThrow(/STORAGE_DRIVER/);
  });

  it('needs both Aadhaar keys, 32 bytes each and different, in every environment', () => {
    const { IDENTITY_ENCRYPTION_KEY, IDENTITY_HMAC_KEY: _hmac, ...bare } = base;
    expect(() => parseEnv(bare)).toThrow(/IDENTITY_ENCRYPTION_KEY/);
    expect(() => parseEnv({ ...bare, IDENTITY_ENCRYPTION_KEY })).toThrow(/IDENTITY_HMAC_KEY/);
    expect(() => parseEnv({ ...base, IDENTITY_HMAC_KEY: 'c2hvcnQ=' })).toThrow(/IDENTITY_HMAC_KEY/);
    expect(() => parseEnv({ ...base, IDENTITY_HMAC_KEY: ENCRYPTION })).toThrow(/IDENTITY_HMAC_KEY/);
    expect(parseEnv(base).IDENTITY_HMAC_KEY).toBe(HMAC);
  });

  it.each(['staging', 'production'])(
    'refuses the Aadhaar keys published in the repository in %s',
    (NODE_ENV) => {
      const deployed = {
        ...base,
        NODE_ENV,
        EMAIL_DRIVER: 'smtp',
        STORAGE_DRIVER: 'r2',
        SMTP_URL: 'smtp://x',
        EMAIL_FROM: 'BravyNix <no-reply@bravynix.in>',
        OTP_HMAC_SECRET: SECRET,
        JWT_SIGNING_KEY: 'pem',
        MFA_ENCRYPTION_KEY: KEY,
      };
      expect(parseEnv(deployed).IDENTITY_HMAC_KEY).toBe(HMAC);
      for (const published of PUBLISHED_IDENTITY_KEYS) {
        expect(() => parseEnv({ ...deployed, IDENTITY_ENCRYPTION_KEY: published })).toThrow(
          /IDENTITY_ENCRYPTION_KEY/,
        );
        expect(() => parseEnv({ ...deployed, IDENTITY_HMAC_KEY: published })).toThrow(
          /IDENTITY_HMAC_KEY/,
        );
        // In development they are fine: that is what they are for.
        expect(parseEnv({ ...base, IDENTITY_HMAC_KEY: published }).IDENTITY_HMAC_KEY).toBe(
          published,
        );
      }
    },
  );

  it('compares keys by the bytes they decode to, not by how they are spelt', () => {
    const published = PUBLISHED_IDENTITY_KEYS[2]!;
    const spellings = [
      published.replace(/=+$/, ''),
      published.replaceAll('+', '-').replaceAll('/', '_'),
      `${published}\n`,
    ];
    const deployed = {
      ...base,
      NODE_ENV: 'production',
      EMAIL_DRIVER: 'smtp',
      STORAGE_DRIVER: 'r2',
      SMTP_URL: 'smtp://x',
      EMAIL_FROM: 'BravyNix <no-reply@bravynix.in>',
      OTP_HMAC_SECRET: SECRET,
      JWT_SIGNING_KEY: 'pem',
      MFA_ENCRYPTION_KEY: KEY,
    };
    for (const spelt of spellings) {
      expect(() => parseEnv({ ...deployed, IDENTITY_HMAC_KEY: spelt })).toThrow(
        /IDENTITY_HMAC_KEY/,
      );
      // The same key spelt two ways is still one key.
      expect(() =>
        parseEnv({ ...base, IDENTITY_ENCRYPTION_KEY: published, IDENTITY_HMAC_KEY: spelt }),
      ).toThrow(/IDENTITY_HMAC_KEY/);
    }
  });

  it.each(['.env.example', 'demo.env'])(
    'lists every Aadhaar key that %s publishes, so production refuses it',
    (file) => {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const published = [...text.matchAll(/^IDENTITY_(?:ENCRYPTION|HMAC)_KEY=(\S+)$/gm)].map(
        (match) => match[1],
      );
      expect(published).toHaveLength(2);
      for (const key of published) expect(PUBLISHED_IDENTITY_KEYS).toContain(key);
    },
  );

  it('validates minimum app versions', () => {
    expect(() => parseEnv({ ...base, MIN_APP_VERSION_IOS: '1.2' })).toThrow(/MIN_APP_VERSION_IOS/);
    expect(parseEnv({ ...base, MIN_APP_VERSION_IOS: '1.2.0' }).MIN_APP_VERSION_IOS).toBe('1.2.0');
  });

  describe('login code settings', () => {
    const deployed = {
      ...base,
      NODE_ENV: 'production',
      EMAIL_DRIVER: 'smtp',
      STORAGE_DRIVER: 'r2',
      SMTP_URL: 'smtp://x',
      EMAIL_FROM: 'BravyNix <no-reply@bravynix.in>',
    };

    it('needs a secret of at least 32 characters in staging and production', () => {
      expect(() => parseEnv(deployed)).toThrow(/OTP_HMAC_SECRET/);
      expect(() => parseEnv({ ...deployed, OTP_HMAC_SECRET: 'short' })).toThrow(/OTP_HMAC_SECRET/);
      expect(
        parseEnv({
          ...deployed,
          OTP_HMAC_SECRET: SECRET,
          JWT_SIGNING_KEY: 'pem',
          MFA_ENCRYPTION_KEY: KEY,
        }).OTP_HMAC_SECRET,
      ).toBe(SECRET);
    });

    it('needs a token signing key in staging and production only', () => {
      const withSecret = { ...deployed, OTP_HMAC_SECRET: SECRET, MFA_ENCRYPTION_KEY: KEY };
      expect(() => parseEnv(withSecret)).toThrow(/JWT_SIGNING_KEY/);
      expect(parseEnv({ ...withSecret, JWT_SIGNING_KEY: 'pem' }).JWT_KEY_ID).toBe('k1');
      expect(parseEnv({ ...base }).JWT_SIGNING_KEY).toBeUndefined();
    });

    it('needs a 32-byte authenticator key in staging and production only', () => {
      const withSecrets = { ...deployed, OTP_HMAC_SECRET: SECRET, JWT_SIGNING_KEY: 'pem' };
      expect(() => parseEnv(withSecrets)).toThrow(/MFA_ENCRYPTION_KEY/);
      expect(() => parseEnv({ ...withSecrets, MFA_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(
        /MFA_ENCRYPTION_KEY/,
      );
      expect(parseEnv({ ...withSecrets, MFA_ENCRYPTION_KEY: KEY }).MFA_ENCRYPTION_KEY).toBe(KEY);
      expect(parseEnv({ ...base }).MFA_ENCRYPTION_KEY).toBeUndefined();
    });

    it('does not need a secret in development, and echo is off by default', () => {
      const env = parseEnv({ ...base });
      expect(env.OTP_HMAC_SECRET).toBeUndefined();
      expect(env.OTP_DEV_ECHO).toBe(false);
    });

    it('allows the development echo in development and test only', () => {
      expect(parseEnv({ ...base, OTP_DEV_ECHO: 'true' }).OTP_DEV_ECHO).toBe(true);
      expect(parseEnv({ ...base, NODE_ENV: 'test', OTP_DEV_ECHO: 'true' }).OTP_DEV_ECHO).toBe(true);
      for (const NODE_ENV of ['staging', 'production']) {
        expect(() =>
          parseEnv({
            ...deployed,
            NODE_ENV,
            OTP_HMAC_SECRET: SECRET,
            JWT_SIGNING_KEY: 'pem',
            MFA_ENCRYPTION_KEY: KEY,
            OTP_DEV_ECHO: 'true',
          }),
        ).toThrow(/OTP_DEV_ECHO/);
      }
    });

    it('rejects anything but true or false for the echo', () => {
      expect(() => parseEnv({ ...base, OTP_DEV_ECHO: 'yes' })).toThrow(/OTP_DEV_ECHO/);
    });
  });
});
