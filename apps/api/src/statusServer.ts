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
import { renderBadgeSvg, renderRssXml } from './status/format';
import { spaFallback } from './core/spaFallback';
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
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(renderRssXml(bundle, env.PUBLIC_URL));
  });
  app.get('/api/v1/status/badge.svg', async (_req, res) => {
    const bundle = (await publicStatusBundle()) as { overall: string };
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(renderBadgeSvg(bundle.overall));
  });

  // Serve the SPA too (status page route inside the app).
  const spaDir = PATHS.webDist;
  if (fs.existsSync(spaDir)) {
    app.use(express.static(spaDir, { index: false, maxAge: '7d' }));
    // G-13: missing /assets/ or /3d/ files are 404, never index.html with 200.
    spaFallback(app, spaDir);
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

// NEW-05: log and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('[voltlink] status unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[voltlink] status uncaughtException:', err);
});
