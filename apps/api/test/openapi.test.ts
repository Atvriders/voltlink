// OpenAPI route-coverage and drift tests (C-OPENAPI, gate 11).
//
//  1. GET /api/docs answers with the spec generated from the live route table.
//  2. Every registered route appears in the spec (no undocumented operations).
//  3. Every spec path exists in the route table (no phantom operations).
//  4. The committed snapshots (apps/api/openapi.json, docs/openapi.json) equal
//     the generated document, so docs cannot silently drift.
//  5. The command enum is the real COMMAND_TYPES (no climate_on/off ghosts).
//  6. Security schemes exist and are applied consistently with the policies.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { ROUTE_TABLE } from '../src/authz/policy';
import { buildOpenApiSpec } from '../src/docs/openapi';
import { COMMAND_TYPES } from '@voltlink/shared';

const API_ROOT = path.resolve(__dirname, '..');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = buildApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function dedupedRoutes() {
  const seen = new Set<string>();
  return ROUTE_TABLE.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe('OpenAPI route coverage', () => {
  it('serves a generated spec at /api/docs', async () => {
    const res = await request(base).get('/api/docs');
    expect(res.status).toBe(200);
    const spec = JSON.parse(res.text) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(100);
  });

  it('documents every registered route', async () => {
    const res = await request(base).get('/api/docs');
    const spec = JSON.parse(res.text) as {
      paths: Record<string, Record<string, unknown>>;
    };
    for (const route of dedupedRoutes()) {
      const item = spec.paths[route.path];
      expect(item, `missing path ${route.path}`).toBeDefined();
      expect(
        item[route.method.toLowerCase()],
        `missing operation ${route.method} ${route.path}`,
      ).toBeDefined();
    }
  });

  it('contains no phantom operations (spec paths all exist)', async () => {
    const res = await request(base).get('/api/docs');
    const spec = JSON.parse(res.text) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const live = new Set(dedupedRoutes().map((r) => `${r.method} ${r.path}`));
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        expect(
          live.has(`${method.toUpperCase()} ${path}`),
          `spec documents a route that does not exist: ${method.toUpperCase()} ${path}`,
        ).toBe(true);
      }
    }
  });

  it('committed snapshots equal the generated document', () => {
    const generated = buildOpenApiSpec();
    for (const rel of ['openapi.json', '../../docs/openapi.json']) {
      const file = path.join(API_ROOT, rel);
      expect(fs.existsSync(file), `${rel} missing — run scripts/generate-openapi.ts`).toBe(true);
      const committed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      expect(committed, `${rel} drifted from the route table`).toEqual(generated);
    }
  });

  it('uses the real command types in the command request schema', () => {
    const spec = buildOpenApiSpec() as {
      paths: Record<string, Record<string, { requestBody?: { content: { 'application/json': { schema: { properties: { type: { enum: string[] } } } } } } }>>;
    };
    const cmd = spec.paths['/api/v1/commands']?.post;
    expect(cmd).toBeDefined();
    const schema = cmd?.requestBody?.content['application/json']?.schema;
    expect(schema).toBeDefined();
    const enumValues = schema?.properties?.type?.enum ?? [];
    expect([...enumValues].sort()).toEqual([...COMMAND_TYPES].sort());
    expect(enumValues).not.toContain('climate_on');
    expect(enumValues).not.toContain('enable_sentry');
  });

  it('declares security schemes and applies them per policy', () => {
    const spec = buildOpenApiSpec() as {
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    expect(spec.components.securitySchemes.sessionCookie).toBeDefined();
    expect(spec.components.securitySchemes.csrfHeader).toBeDefined();
    expect(spec.components.securitySchemes.bearerApiKey).toBeDefined();

    const live = new Map(dedupedRoutes().map((r) => [`${r.method} ${r.path}`, r.policy.auth]));
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const auth = live.get(`${method.toUpperCase()} ${path}`);
        expect(auth, `spec-only operation ${method} ${path}`).toBeDefined();
        if (auth === 'public') {
          expect(op.security ?? [], `${method} ${path} should be public`).toEqual([]);
        } else {
          expect(Array.isArray(op.security), `${method} ${path} needs security`).toBe(true);
        }
      }
    }
  });
});
