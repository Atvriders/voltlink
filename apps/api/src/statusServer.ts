// Public status role: serves ONLY the public status experience (status page
// assets + public status API) in a separate process, so genuinely independent
// uptime visibility is possible on a separate host/port.

import express from 'express';
import { cspExtraOrigins, securityHeaders } from './core/securityHeaders';
import path from 'node:path';
import fs from 'node:fs';
import { env, validateEnv } from './core/env';
import { prisma } from './core/db';
import { waitForMigrations } from './cli/migrate';
import { ensureComponents, publicStatusBundle, runStatusChecks } from './status/service';
import { APP_VERSION } from '@voltlink/shared';
import { PATHS } from './core/paths';

async function main(): Promise<void> {
  validateEnv();
  await waitForMigrations();
  await prisma.$connect();
  await ensureComponents();

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders(env.PUBLIC_URL, cspExtraOrigins(env.CSP_CONNECT_ORIGINS)));

  app.get('/healthz', (_req, res) => res.json({ ok: true, role: 'status', version: APP_VERSION }));
  app.get('/api/v1/status', async (_req, res) => {
    res.json({ data: await publicStatusBundle() });
  });
  app.get('/api/v1/status/rss', async (_req, res) => {
    const bundle = (await publicStatusBundle()) as {
      incidents: {
        id: string;
        title: string;
        severity: string;
        status: string;
        updates: { message: string; createdAt: string }[];
      }[];
      updatedAt: string;
    };
    const items = bundle.incidents
      .slice(0, 20)
      .map(
        (i) =>
          `<item><title>${escapeXml(i.title)}</title><guid>${i.id}</guid><pubDate>${new Date(bundle.updatedAt).toUTCString()}</pubDate><description>${escapeXml(i.updates[0]?.message ?? i.status)}</description></item>`,
      )
      .join('');
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>VoltLink Status</title><description>VoltLink platform status updates</description>${items}</channel></rss>`,
    );
  });
  app.get('/api/v1/status/badge.svg', async (_req, res) => {
    const bundle = (await publicStatusBundle()) as { overall: string };
    const labels: Record<string, [string, string]> = {
      operational: ['Operational', '#2e7d32'],
      degraded: ['Degraded', '#f9a825'],
      partial_outage: ['Partial outage', '#ef6c00'],
      major_outage: ['Major outage', '#c62828'],
      maintenance: ['Maintenance', '#1565c0'],
      unknown: ['Unknown', '#607d8b'],
    };
    const [label, color] = (labels[bundle.overall] ?? labels.unknown) as [string, string];
    const width = 24 + label.length * 7 + 10;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20"><rect width="${width}" height="20" rx="4" fill="#424242"/><rect x="${width / 2}" width="${width / 2}" height="20" fill="${color}"/><text x="6" y="14" font-family="Arial" font-size="11" fill="#fff">VoltLink</text><text x="${width / 2 + 6}" y="14" font-family="Arial" font-size="11" fill="#fff">${label}</text></svg>`,
    );
  });

  // Serve the SPA too (status page route inside the app).
  const spaDir = PATHS.webDist;
  if (fs.existsSync(spaDir)) {
    app.use(express.static(spaDir, { index: false, maxAge: '7d' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') {
        next();
        return;
      }
      res.sendFile(path.join(spaDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.send('VoltLink status process — SPA not built.'));
  }

  void runStatusChecks().catch(() => undefined);
  const checks = setInterval(() => void runStatusChecks().catch(() => undefined), 3600_000);
  checks.unref();

  const port = Number(process.env.STATUS_PORT || 3001);
  const server = app.listen(port, env.HOST, () =>
    console.log(`[voltlink] status listening on ${env.HOST}:${port}`),
  );
  const shutdown = () => {
    server.close(() => prisma.$disconnect().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main().catch((err) => {
  console.error('[voltlink] status fatal error:', err);
  process.exit(1);
});

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
