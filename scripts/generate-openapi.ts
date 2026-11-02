// Regenerates the committed OpenAPI snapshots from the live route table.
//
//   npx tsx scripts/generate-openapi.ts
//
// The running server never reads these files (GET /api/docs generates the
// spec at request time); the snapshots exist as the repo artifact for docs
// and as the drift-check baseline in apps/api/test/openapi.test.ts.
//
// Imports the API app so every router registers itself into ROUTE_TABLE.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  await import('../apps/api/src/app');
  const { buildOpenApiSpec } = await import('../apps/api/src/docs/openapi');
  const spec = buildOpenApiSpec();
  const json = `${JSON.stringify(spec, null, 2)}\n`;

  const targets = [
    path.join(root, 'apps/api/openapi.json'),
    path.join(root, 'docs/openapi.json'),
  ];
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json);
    console.log(`wrote ${path.relative(root, target)} (${json.length} bytes)`);
  }
  const ops = Object.values(spec.paths as Record<string, Record<string, unknown>>).reduce(
    (n, item) => n + Object.keys(item).length,
    0,
  );
  console.log(`operations documented: ${ops}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
