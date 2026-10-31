import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

execFileSync('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], { stdio: 'inherit' });

import { writeFileSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true }); // never ship stale bundles

// Every external must be a `dependencies` entry of @voltlink/api: the in-image
// self-test requires each of them at runtime (guide 04 §2.4).
const EXTERNALS = ['@prisma/client', 'prisma', 'argon2', 'nodemailer', 'web-push', 'ioredis', 'undici'];

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  target: 'node20',
  sourcemap: false,
  outdir: 'dist',
  external: EXTERNALS,
  logLevel: 'warning',
};
await Promise.all([
  build({ ...common, entryPoints: { index: 'src/index.ts' } }),
  build({ ...common, entryPoints: { worker: 'src/worker.ts' } }),
  build({ ...common, entryPoints: { scheduler: 'src/scheduler.ts' } }),
  build({ ...common, entryPoints: { statusServer: 'src/statusServer.ts' } }),
  build({ ...common, entryPoints: { 'cli/migrate': 'src/cli/migrate.ts' } }),
  build({ ...common, entryPoints: { 'cli/selftest': 'src/cli/selftest.ts' } }),
]);
writeFileSync('dist/externals.json', JSON.stringify(EXTERNALS));
console.log('api bundle ok');
