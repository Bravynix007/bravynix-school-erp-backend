import { writeFileSync } from 'node:fs';
import { RoleShortName } from '../common/auth/roles.js';
import { PolicyRegistry } from '../common/auth/policy-registry.js';
import { createCliApp } from './app-context.js';

/**
 * Writes `policies.json`: every endpoint with its declared role policy. QA
 * generates the endpoint × persona authorization matrix from it
 * (QA strategy 6).
 */
const app = await createCliApp();
try {
  const routes = app
    .get(PolicyRegistry)
    .routes()
    .map((route) => ({
      method: route.method,
      path: route.path,
      operationId: route.policy?.operationId ?? null,
      access: route.policy?.access ?? null,
      roles: route.policy?.roles.map((role) => RoleShortName[role]) ?? [],
      scope: route.policy?.scope ?? null,
      allowWhenBlocked: route.policy?.allowWhenBlocked ?? false,
      rule: route.policy?.rule ?? null,
      handler: `${route.controller}.${route.handler}`,
    }));
  const target = process.argv[2] ?? 'policies.json';
  writeFileSync(target, `${JSON.stringify({ routes }, null, 2)}\n`);
  console.log(`Wrote ${target} (${routes.length} routes)`);
} finally {
  await app.close();
}
