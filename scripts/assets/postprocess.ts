// scripts/assets/postprocess.ts — dedup/prune/meshopt every staged GLB.
// Uses the pinned @gltf-transform/cli; pivots stay safe because articulated
// meshes live on child nodes under pivot empties (guide 06 §1.3).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = path.join(root, 'assets', 'models');
const outDir = path.join(root, 'assets', 'models', 'processed');

function run(args: string[]): void {
  const bin = path.join(root, 'node_modules', '.bin', 'gltf-transform');
  const res = spawnSync(bin, args, { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`gltf-transform ${args.join(' ')} failed`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
const files = readdirSync(srcDir).filter((f) => f.endsWith('.glb'));
for (const file of files) {
  const src = path.join(srcDir, file);
  const out = path.join(outDir, file);
  const t1 = path.join(outDir, file.replace('.glb', '.t1.glb'));
  const t2 = path.join(outDir, file.replace('.glb', '.t2.glb'));
  // No textures in this pipeline; the KTX2/WebP steps are intentionally a
  // no-op and the manifest records the texture backend as "none".
  run(['dedup', src, t1]);
  run(['prune', t1, t2, '--keep-leaves', 'true']);
  run(['meshopt', t2, out]);
  for (const tmp of [t1, t2]) if (existsSync(tmp)) require('node:fs').rmSync(tmp);
  console.log(`postprocessed ${file} -> processed/${file}`);
}
console.log('postprocess done');
