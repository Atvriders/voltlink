// G-13: missing /assets/ and /3d/ GETs must be 404 in both SPA fallbacks.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('spa fallback (G-13)', () => {
  it('returns 404 for missing assets instead of index.html', async () => {
    const { spaFallback } = await import('./spaFallback');
    const dir = mkdtempSync(path.join(tmpdir(), 'spa-fallback-'));
    writeFileSync(path.join(dir, 'index.html'), '<html>index</html>');
    const app = express();
    spaFallback(app, dir);
    const server: Server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const missingAsset = await request(base).get('/assets/nope.js');
      expect(missingAsset.status).toBe(404);
      expect(missingAsset.headers['content-type']).not.toMatch(/text\/html/);
      const missing3d = await request(base).get('/3d/model.glb');
      expect(missing3d.status).toBe(404);
      const route = await request(base).get('/deep/link');
      expect(route.status).toBe(200);
      expect(route.text).toContain('index');
    } finally {
      // TI-51: the temp spa-fallback dir leaked on every run.
      rmSync(dir, { recursive: true, force: true });
      server.close();
    }
  });
});
