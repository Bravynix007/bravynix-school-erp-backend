import { assertSeedable } from './seed-guard.js';

describe('assertSeedable', () => {
  it.each([
    'postgres://erp_migrator@localhost:5432/school_erp',
    'postgres://erp_migrator@127.0.0.1/school_erp_test',
    'postgres://erp_migrator@[::1]:5432/school_erp',
    'postgres://erp_migrator@postgres:5432/school_erp',
  ])('allows the local database %s', (url) => {
    expect(() => assertSeedable(url, 'development')).not.toThrow();
  });

  it('refuses a remote host even with NODE_ENV unset', () => {
    expect(() =>
      assertSeedable('postgres://erp_migrator@db.staging.example.in/school_erp', undefined),
    ).toThrow(/only local databases/);
  });

  it.each(['staging', 'production'])('refuses NODE_ENV=%s', (env) => {
    expect(() => assertSeedable('postgres://erp_migrator@localhost/school_erp', env)).toThrow(
      /refused in staging and production/,
    );
  });
});
