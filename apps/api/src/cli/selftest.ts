// In-image self-test (guide 04 §2.4): runs at build time inside the runtime
// stage and as the `selftest` role. No database or Redis needed.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../core/paths';

async function main(): Promise<void> {
  const req = createRequire(path.join(PATHS.root, 'dist', 'index.cjs'));
  const externals: string[] = JSON.parse(fs.readFileSync(path.join(PATHS.root, 'dist', 'externals.json'), 'utf8'));
  for (const name of externals) {
    if (name === 'prisma') {
      // prisma's main is ESM-only; the CLI is executed as its own process.
      const prismaRoot = path.dirname(req.resolve('prisma/package.json'));
      fs.accessSync(path.join(prismaRoot, 'build', 'index.js'));
      continue;
    }
    req(name); // MODULE_NOT_FOUND -> exit 1
  }
  new (req('@prisma/client').PrismaClient)(); // the stub throws here
  const argon2 = req('argon2');
  if (!(await argon2.verify(await argon2.hash('voltlink-selftest'), 'voltlink-selftest'))) throw new Error('argon2 self-check failed');
  for (const p of [PATHS.schema, PATHS.migrations, path.join(PATHS.webDist, 'index.html')]) {
    fs.accessSync(p);
  }
  const paths = JSON.parse(fs.readFileSync(PATHS.openapi, 'utf8')).paths ?? {};
  if (!Object.keys(paths).length) throw new Error('openapi.json has no paths');
  console.log(`[voltlink] selftest ok (${externals.length} externals)`);
}

main().catch((err) => {
  console.error('[voltlink] selftest FAILED', err);
  process.exit(1);
});
