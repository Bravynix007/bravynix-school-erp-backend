import { SCENARIOS, seedScenario } from './seed-runner.js';

describe('seedScenario', () => {
  it('knows the two-worlds and demo scenarios', () => {
    expect(Object.keys(SCENARIOS).toSorted()).toEqual(['demo', 'two-worlds']);
  });

  it('refuses a scenario it does not know, before it connects anywhere', async () => {
    await expect(
      seedScenario('nope', 'postgres://erp_migrator@localhost/school_erp', 'development'),
    ).rejects.toThrow(/Unknown scenario "nope"/);
  });

  it.each(['two-worlds', 'demo'])('refuses a remote database for %s', async (name) => {
    await expect(
      seedScenario(name, 'postgres://erp_migrator@db.example.in/school_erp', 'development'),
    ).rejects.toThrow(/only local databases/);
  });

  it('refuses production for the demo', async () => {
    await expect(
      seedScenario('demo', 'postgres://erp_migrator@localhost/school_erp', 'production'),
    ).rejects.toThrow(/refused in staging and production/);
  });

  it('writes no password and no key: every demo email is on a reserved domain', async () => {
    const { people } = await import('../seeds/demo.js');
    for (const p of people) expect(p.email).toMatch(/@demo\.test$/);
  });
});
