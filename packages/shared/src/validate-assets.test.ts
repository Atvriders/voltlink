// validate-assets.test.ts — C-ASSETVALID end-to-end: the validator fails the
// build on a malformed GLB and passes a known-good pipeline output (guide 06
// §12). Runs the real validator via tsx in a subprocess.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const validator = path.join(root, 'scripts', 'assets', 'validate.mts');

function runValidator(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), validator, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('C-ASSETVALID validator', () => {
  it('fails with SPEC_INVALID on a malformed GLB (R2-63)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voltlink-bad-'));
    try {
      writeFileSync(
        path.join(dir, 'compact_sedan.glb'),
        Buffer.from('glTF' + '\x02\x00\x00\x00' + '\x00\x00\x00\x00'.repeat(64)),
      );
      const { status, out } = runValidator(['--staged', dir]);
      expect(status).not.toBe(0);
      // R2-63: a malformed GLB is a SPEC_INVALID finding from the GLB parse
      // branch — never the unrelated 'no class spec for file' branch, and
      // never an uncaught crash. Crash signatures (a stack line, the Node.js
      // version banner, a config ENOENT) all fail the test; the parser's own
      // message is REQUIRED as the GLB-level detail (so a correct fix that
      // quotes it still passes).
      expect(out).toContain('SPEC_INVALID');
      expect(out).not.toContain('no class spec');
      expect(out).toMatch(/Missing required GLB JSON chunk/);
      expect(out).not.toMatch(/^\s+at /m);
      expect(out).not.toContain('Node.js v');
      expect(out).not.toMatch(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a known-good processed vehicle', () => {
    const src = path.join(root, 'assets', 'models', 'processed', 'compact_sedan.glb');
    const dir = mkdtempSync(path.join(tmpdir(), 'voltlink-good-'));
    try {
      copyFileSync(src, path.join(dir, 'compact_sedan.glb'));
      const { status, out } = runValidator(['--staged', dir]);
      expect(status).toBe(0);
      expect(out).not.toMatch(/FAIL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails ENVELOPE when a mesh node is exported below the ground plane (R2-39)', async () => {
    const { NodeIO } = await import('@gltf-transform/core');
    const io = new NodeIO();
    const src = path.join(root, 'assets', 'models', 'processed', 'compact_sedan.glb');
    const doc = await io.read(src);
    const target = doc
      .getRoot()
      .listNodes()
      .find((n) => (n.getName() ?? '').endsWith('_mesh') && n.getMesh());
    expect(target, 'a mesh node exists in the fixture').toBeTruthy();
    // R2-39: the old generator's parent-inverse bug exported door windows
    // under the car. Any mesh below the ground plane must fail the build.
    const t = target!.getTranslation();
    target!.setTranslation([t[0], t[1] - 5, t[2]]);
    const dir = mkdtempSync(path.join(tmpdir(), 'voltlink-ground-'));
    try {
      const data = await io.writeBinary(doc);
      writeFileSync(path.join(dir, 'compact_sedan.glb'), data);
      const { status, out } = runValidator(['--staged', dir]);
      expect(status).not.toBe(0);
      expect(out).toContain('below ground');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
