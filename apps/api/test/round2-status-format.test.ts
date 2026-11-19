// R5: N-STATUSMISC — badge.svg must be wide enough for its label (measured),
// and the RSS feed needs a channel link + stable per-incident guids/dates.
process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { ensureComponents } from '../src/status/service';

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

describe('badge + rss fidelity (N-STATUSMISC)', { tags: ['status-page'] }, () => {
  it('badge.svg is wide enough to hold the longest label text', async () => {
    await ensureComponents();
    await prisma.statusComponent.updateMany({ data: { status: 'major_outage' } });
    const res = await request(base).get('/api/v1/status/badge.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
    const body = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : (res.text as string);
    const width = Number(/width="(\d+)"/.exec(body)?.[1]);
    expect(Number.isFinite(width)).toBe(true);
    // Second <text> is the label; find its x.
    const texts = [...body.matchAll(/<text x="([\d.]+)"[^>]*>([A-Za-z ]+)<\/text>/g)];
    const labelXMatch = texts[texts.length - 1];
    expect(labelXMatch).toBeDefined();
    expect(labelXMatch![2]).toBe('Major outage');
    const labelX = Number(labelXMatch![1]);
    // Independent lower bound: 'Major outage' in 11px Arial is >=5.6px/char.
    expect(width).toBeGreaterThanOrEqual(labelX + 12 * 5.6 + 4);
  });

  it('rss feed has channel link and stable guids', async () => {
    const inc = await prisma.incident.create({
      data: {
        title: `RSS incident ${randomId().slice(0, 6)}`,
        severity: 'major',
        status: 'identified',
        public: true,
        updates: {
          create: [{ phase: 'identified', message: 'We are on it.', author: 'ops' }],
        },
      },
    });
    const res = await request(base).get('/api/v1/status/rss');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/rss\+xml/);
    const body = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : (res.text as string);
    expect(body).toContain('<channel><title>');
    // TI-30: the channel link must be the real public URL, not just any <link>.
    const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3000';
    expect(body).toContain(`<link>${publicUrl}/status</link>`);
    expect(body).toContain(`<link>${publicUrl}/status#incident-${inc.id}</link>`);
    expect(body).toContain(`isPermaLink="false">${inc.id}</guid>`);
    expect(body).not.toContain('<html');
  });
});
