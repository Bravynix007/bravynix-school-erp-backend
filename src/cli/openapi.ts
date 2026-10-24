import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../bootstrap/openapi.js';
import { createCliApp } from './app-context.js';

/** Writes `openapi.json`, the contract QA's contract tests run against. */
const app = await createCliApp();
try {
  const document = buildOpenApiDocument(app);
  const target = process.argv[2] ?? 'openapi.json';
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${target} (${Object.keys(document.paths).length} paths)`);
} finally {
  await app.close();
}
