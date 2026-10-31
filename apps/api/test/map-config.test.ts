// F-MAPGRID: operator basemap configuration — boot parsing, /api/v1/config/client,
// CSP origins and the /tiles static mount (404, never index.html).
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadMapConfig } from '../src/core/mapConfig';
import { buildApp } from '../src/app';

let server: Server;
let base = '';

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voltlink-tiles-'));
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'region.pmtiles'), Buffer.from('PMTiles fixture'));
  process.env.VL_MAP_MODE = 'pmtiles';
  process.env.VL_MAP_PMTILES_URL = '/tiles/region.pmtiles';
  process.env.VL_MAP_TILES_DIR = dir;
  process.env.VL_MAP_ASSETS_URL = 'https://tiles.example.com/assets';
  process.env.VL_MAP_ATTRIBUTION = '© Example';
  server = buildApp({ serveSpa: false }).listen(0);
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server.close();
  delete process.env.VL_MAP_MODE;
  delete process.env.VL_MAP_PMTILES_URL;
  delete process.env.VL_MAP_TILES_DIR;
  delete process.env.VL_MAP_ASSETS_URL;
  delete process.env.VL_MAP_ATTRIBUTION;
});

describe('loadMapConfig', () => {
  it('defaults to demo and exposes the client object', () => {
    const cfg = loadMapConfig({});
    expect(cfg.mode).toBe('demo');
    expect(cfg.client.mode).toBe('demo');
  });
  it('requires a style URL in style mode', () => {
    expect(() => loadMapConfig({ VL_MAP_MODE: 'style' })).toThrow();
  });
  it('collects CSP origins from style, pmtiles and assets URLs', () => {
    const cfg = loadMapConfig({
      VL_MAP_MODE: 'style',
      VL_MAP_STYLE_URL: 'https://tiles.example.com/styles/liberty',
      VL_MAP_PMTILES_URL: 'https://tiles.example.net/region.pmtiles',
    });
    expect(cfg.cspOrigins).toContain('https://tiles.example.com');
    expect(cfg.cspOrigins).toContain('https://tiles.example.net');
  });
});

describe('map instance wiring', () => {
  it('serves tiles from the configured directory', async () => {
    const res = await request(base).get('/tiles/region.pmtiles');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
  });
  it('returns 404 (never index.html) for missing tiles', async () => {
    const res = await request(base).get('/tiles/missing.pmtiles');
    expect(res.status).toBe(404);
  });
  it('lists the configured origins in the CSP', async () => {
    const res = await request(base).get('/api/docs');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('https://tiles.example.com');
  });
});
