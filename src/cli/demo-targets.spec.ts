import { DEMO_DATABASE, demoResetTargets, withDatabase } from './demo-targets.js';

const demoUrl = `postgres://erp_migrator:erp_migrator@localhost:5432/${DEMO_DATABASE}`;
const env = (changes: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  DATABASE_MIGRATION_URL: demoUrl,
  ...changes,
});

describe('demoResetTargets', () => {
  it('accepts the demo database on a local server, with the docker compose administrator by default', () => {
    expect(demoResetTargets(env())).toEqual({
      migrationUrl: demoUrl,
      adminUrl: 'postgres://postgres:postgres@localhost:5432/postgres',
    });
  });

  it('takes the administrator from DEMO_ADMIN_URL, always on the maintenance database', () => {
    const { adminUrl } = demoResetTargets(
      env({ DEMO_ADMIN_URL: 'postgres://admin:x@127.0.0.1:5433/school_erp' }),
    );
    expect(adminUrl).toBe('postgres://admin:x@127.0.0.1:5433/postgres');
  });

  it('refuses when no migration URL is set', () => {
    expect(() => demoResetTargets(env({ DATABASE_MIGRATION_URL: undefined }))).toThrow(
      /Set DATABASE_MIGRATION_URL/,
    );
  });

  it('refuses a migration URL that names another database, such as the one a shell variable points at', () => {
    expect(() =>
      demoResetTargets(
        env({ DATABASE_MIGRATION_URL: 'postgres://erp_migrator@localhost:5432/school_erp' }),
      ),
    ).toThrow(/only rebuilds school_erp_demo, not school_erp$/);
  });

  it('refuses a remote administrator server', () => {
    expect(() =>
      demoResetTargets(env({ DEMO_ADMIN_URL: 'postgres://postgres@db.example.in:5432/postgres' })),
    ).toThrow(/only local databases/);
  });

  it('refuses a remote migration server, even with the right database name', () => {
    expect(() =>
      demoResetTargets(
        env({ DATABASE_MIGRATION_URL: `postgres://erp_migrator@db.example.in/${DEMO_DATABASE}` }),
      ),
    ).toThrow(/only local databases/);
  });

  it.each(['staging', 'production'])('refuses NODE_ENV=%s', (nodeEnv) => {
    expect(() => demoResetTargets(env({ NODE_ENV: nodeEnv }))).toThrow(
      /refused in staging and production/,
    );
  });
});

describe('withDatabase', () => {
  it('swaps only the database name', () => {
    expect(withDatabase('postgres://u:p@localhost:5432/one?x=1', 'two')).toBe(
      'postgres://u:p@localhost:5432/two?x=1',
    );
  });
});
