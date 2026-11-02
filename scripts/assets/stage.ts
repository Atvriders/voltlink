// scripts/assets/stage.ts — copy processed GLBs into apps/web/public/3d as
// <name>.<sha256:10>.<ext> and write /3d/manifest.json (guide 06 §11).
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = path.join(root, 'assets', 'models', 'processed');
const outDir = path.join(root, 'apps', 'web', 'public', '3d');
const oldModels = path.join(root, 'apps', 'web', 'public', 'assets', 'models');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

function walk(rel: string): string[] {
  const dir = path.join(src, rel);
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.glb'))
    .sort()
    .map((f) => path.join(rel, f));
}

const files: Record<string, { url: string; bytes: number; sha256: string }> = {};
for (const file of walk('')) {
  const data = readFileSync(path.join(src, file));
  const sha = createHash('sha256').update(data).digest('hex');
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const outName = `${base}.${sha.slice(0, 10)}${ext}`;
  copyFileSync(path.join(src, file), path.join(outDir, outName));
  files[base] = { url: `/3d/${outName}`, bytes: data.length, sha256: sha };
}
for (const file of walk('env')) {
  const data = readFileSync(path.join(src, file));
  const sha = createHash('sha256').update(data).digest('hex');
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const outName = `${base}.${sha.slice(0, 10)}${ext}`;
  copyFileSync(path.join(src, file), path.join(outDir, outName));
  files[base] = { url: `/3d/${outName}`, bytes: data.length, sha256: sha };
}
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ version: 1, files }, null, 2));
if (statSync(oldModels, { throwIfNoEntry: false })) {
  rmSync(oldModels, { recursive: true, force: true });
}
console.log(`staged ${Object.keys(files).length} assets into public/3d`);
