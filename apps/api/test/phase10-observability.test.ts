// test/phase10-observability.test.ts — /metrics families and request
// identification (guide 08 §7: observability minimums).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { metricsText } from '../src/core/metrics';

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
  await prisma.$disconnect();
});

describe('observability', () => {
  it('/metrics exposes process and business families', async () => {
    const res = await request(base).get('/metrics');
    expect(res.status).toBe(200);
    const text = res.text as string;
    expect(text).toMatch(/voltlink_process_info/);
    expect(text).toMatch(/voltlink_process_uptime_seconds/);
    // Business metrics exist even at zero: their TYPE lines always render.
    expect(text).toMatch(/voltlink_command_total/);
  });

  it('metricsText never contains raw secrets or PII', () => {
    const text = metricsText();
    expect(text).not.toMatch(/password|token|secret|@/i);
  });

  it('every error response carries a requestId', async () => {
    const res = await request(base).get('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    const body = res.body as { error?: { requestId?: string }; requestId?: string };
    expect(body?.requestId ?? body?.error?.requestId).toBeTruthy();
  });

  it('healthz is liveness and readyz reports the database', async () => {
    const liveness = await request(base).get('/healthz');
    expect(liveness.status).toBe(200);
    const ready = await request(base).get('/readyz');
    // 200 with a migrated template DB, or 503 with an explicit reason.
    expect([200, 503]).toContain(ready.status);
    const body = ready.body as { ready?: boolean; reason?: string };
    if (ready.status === 503) expect(body.reason).toBeTruthy();
  });
});
