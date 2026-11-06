// R5: N-STATUSMISC — uptime90dPct is a real 90-day figure, not a relabelled
// 30-day one, and the bundle carries a per-day series.
process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';

let server: Server;
let base = '';

beforeAll(async () => {
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('status uptime truth (N-STATUSMISC)', () => {
  it('uptime90dPct spans 90 days while uptime30dPct spans 30', async () => {
    const comp = await prisma.statusComponent.create({
      data: {
        key: `maps-${randomId().slice(0, 8)}`,
        name: 'Maps',
        group: 'core',
        status: 'operational',
      },
    });
    // 2 failed checks 60 days ago, 8 ok checks in the last 30 days.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000);
    await prisma.statusCheck.createMany({
      data: [
        { componentKey: comp.key, ok: false, latencyMs: null, detail: 'down', at: sixtyDaysAgo },
        { componentKey: comp.key, ok: false, latencyMs: null, detail: 'down', at: new Date(sixtyDaysAgo.getTime() + 3600_000) },
        { componentKey: comp.key, ok: true, latencyMs: 5, detail: 'ok', at: new Date(Date.now() - 86400000) },
        { componentKey: comp.key, ok: true, latencyMs: 5, detail: 'ok', at: new Date(Date.now() - 7200_000) },
        { componentKey: comp.key, ok: true, latencyMs: 5, detail: 'ok', at: new Date(Date.now() - 3600_000) },
      ],
    });

    const res = await request(base).get('/api/v1/status');
    expect(res.status).toBe(200);
    const bundle = res.body.data;
    const entry = bundle.components.find((c: { key: string }) => c.key === comp.key);
    expect(entry.uptime90dPct).toBeLessThan(100);
    // 30-day window only sees the ok checks.
    expect(bundle.uptime30dPct).toBe(100);
    // Per-day series exists and is truthful.
    expect(Array.isArray(bundle.uptime)).toBe(true);
  });
});
