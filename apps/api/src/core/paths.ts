// Explicit app-root resolution so every role (bundles under dist/*.cjs and
// dist/cli/*.cjs), tsx, vitest and bare-metal runs agree on where the Prisma
// schema, migrations, openapi.json and the staged SPA live — never
// `process.cwd()` (I-BAREMETAL, guide 04 §1).

import fs from 'node:fs';
import path from 'node:path';

function findAppRoot(start: string): string | undefined {
  for (let dir = start, i = 0; i < 6; i++, dir = path.dirname(dir)) {
    try {
      if (
        JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === '@voltlink/api'
      ) {
        return dir;
      }
    } catch {
      /* keep walking */
    }
  }
  return undefined;
}

const here = typeof __dirname === 'string' ? __dirname : process.cwd();

export const APP_ROOT =
  process.env.VL_APP_ROOT ??
  findAppRoot(here) ??
  findAppRoot(path.resolve(process.cwd(), 'apps', 'api')) ??
  process.cwd();

export const PATHS = {
  root: APP_ROOT,
  schema: path.join(APP_ROOT, 'prisma', 'schema.prisma'),
  migrations: path.join(APP_ROOT, 'prisma', 'migrations'),
  openapi: path.join(APP_ROOT, 'openapi.json'),
  webDist: path.join(APP_ROOT, 'web-dist'),
};
