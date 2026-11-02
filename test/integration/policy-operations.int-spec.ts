import { PolicyRegistry } from '../../src/common/auth/policy-registry.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

describe('operation IDs (API design 6.4)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('names each operation once, because the IDs are typed by hand and feed the policy list QA builds its matrix from', () => {
    const routes = t.app.get(PolicyRegistry).routes();
    const seen = new Map<string, string>();
    const repeated: string[] = [];
    for (const route of routes) {
      const id = route.policy?.operationId;
      if (!id) continue;
      const where = `${route.method} ${route.path}`;
      const earlier = seen.get(id);
      if (earlier !== undefined) repeated.push(`${id}: ${earlier} and ${where}`);
      else seen.set(id, where);
    }
    expect(repeated).toEqual([]);
    expect(seen.size).toBeGreaterThan(40);
  });
});
