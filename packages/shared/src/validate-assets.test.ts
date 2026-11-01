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
  it('fails with SPEC_INVALID on a malformed GLB', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voltlink-bad-'));
    try {
      writeFileSync(
        path.join(dir, 'compact_sedan.glb'),
        Buffer.from('glTF' + '\x02\x00\x00\x00' + '\x00\x00\x00\x00'.repeat(64)),
      );
      const { status, out } = runValidator(['--staged', dir]);
      expect(status).not.toBe(0);
      expect(out).toMatch(/FAIL|Error|error/i);
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
});
