// The VoltLink Express application: API routes, real-time SSE, health,
// metrics, and the built SPA (in production).

import express from 'express';
import { cspExtraOrigins, securityHeaders } from './core/securityHeaders';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { env, parseTrustProxy } from './core/env';
import { requestId, csrf, notFound, errorHandler } from './middleware/core';
import { authRouter } from './routes/auth';
import { hooksRouter } from './routes/hooks';
import { usersRouter } from './routes/users';
import { providersRouter } from './routes/providers';
import { vehiclesRouter } from './routes/vehicles';
import { commandsRouter } from './routes/commands';
import { drivesRouter } from './routes/drives';
import { chargingRouter } from './routes/charging';
import { analyticsRouter } from './routes/analytics';
import { automationsRouter } from './routes/automations';
import { notificationsRouter } from './routes/notifications';
import { fleetRouter } from './routes/fleet';
import { statusRouter } from './routes/status';
import { adminRouter } from './routes/admin';
import { orgsRouter, invitationsRouter } from './routes/orgs';
import { sseHandler } from './realtime/hub';
import { authenticate } from './authz/authenticate';
import { AccessDenied } from './authz/errors';
import { getQueue } from './core/queue';
import { prisma } from './core/db';
import { PATHS } from './core/paths';
import { APP_VERSION } from '@voltlink/shared';

const OPENAPI_SPEC: string = (() => {
  try {
    if (fs.existsSync(PATHS.openapi)) return fs.readFileSync(PATHS.openapi, 'utf8');
  } catch {
    // fall through to the minimal stub
  }
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'VoltLink API', version: APP_VERSION },
    paths: {},
  });
})();

export function buildApp(opts: { serveSpa?: boolean } = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const trust = parseTrustProxy(env.TRUST_PROXY);
  if (trust !== false) app.set('trust proxy', trust);

  app.use(securityHeaders(env.PUBLIC_URL, cspExtraOrigins(env.CSP_CONNECT_ORIGINS)));
  app.use(requestId);
  // Inbound hooks need the raw body: mount before express.json() and CSRF.
  app.use('/api/v1/hooks', hooksRouter);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: env.RATE_LIMIT_PER_MIN,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.originalUrl.startsWith('/api/v1/realtime'),
    }),
  );
  app.use('/api', csrf);

  app.get('/api/docs', (_req, res) => {
    res.type('application/json').send(OPENAPI_SPEC);
  });

  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, version: APP_VERSION, uptimeSec: Math.round(process.uptime()) }),
  );
  // Readiness: the container healthcheck probes this after the DB is
  // reachable and every shipped migration is applied.
  app.get('/readyz', async (_req, res) => {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      const { pendingMigrations } = await import('./cli/migrate');
      const queueOk = await getQueue()
        .ping()
        .catch(() => false);
      if ((await pendingMigrations()).length > 0) {
        res.status(503).json({ ready: false, reason: 'migrations_pending', version: APP_VERSION });
        return;
      }
      res.status(queueOk ? 200 : 503).json({
        ready: queueOk,
        reason: queueOk ? undefined : 'queue_unavailable',
        version: APP_VERSION,
      });
    } catch {
      res.status(503).json({ ready: false, reason: 'database_unavailable', version: APP_VERSION });
    }
  });
  app.get('/metrics', (_req, res) => {
    const body = [
      '# HELP voltlink_process_info VoltLink process information',
      `voltlink_process_info{version="${APP_VERSION}",role="${process.env.VL_ROLE ?? 'web'}"} 1`,
      '# HELP voltlink_process_uptime_seconds Process uptime in seconds',
      `voltlink_process_uptime_seconds ${Math.round(process.uptime())}`,
      '# HELP voltlink_process_memory_rss_bytes Resident memory in bytes',
      `voltlink_process_memory_rss_bytes ${process.memoryUsage().rss}`,
    ].join('\n');
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(`${body}\n`);
  });

  app.use(authRouter.prefix, authRouter.router);
  app.use(usersRouter.prefix, usersRouter.router);
  app.use(providersRouter.prefix, providersRouter.router);
  app.use(vehiclesRouter.prefix, vehiclesRouter.router);
  app.use(commandsRouter.prefix, commandsRouter.router);
  app.use(drivesRouter.prefix, drivesRouter.router);
  app.use(chargingRouter.prefix, chargingRouter.router);
  app.use(analyticsRouter.prefix, analyticsRouter.router);
  app.use(automationsRouter.prefix, automationsRouter.router);
  app.use(notificationsRouter.prefix, notificationsRouter.router);
  app.use(fleetRouter.prefix, fleetRouter.router);
  app.use(statusRouter.prefix, statusRouter.router);
  app.use(adminRouter.prefix, adminRouter.router);
  app.use(orgsRouter.prefix, orgsRouter.router);
  app.use(invitationsRouter.prefix, invitationsRouter.router);
  app.use('/api/v1/exports', usersRouter.router);

  // Real-time events (SSE).
  app.get('/api/v1/realtime', async (req, res) => {
    const actor = await authenticate(req, 'session');
    if (actor.kind !== 'session')
      throw new AccessDenied(
        'API_KEY_NOT_ALLOWED',
        'This endpoint requires an interactive session.',
        403,
      );
    req.actor = actor;
    await sseHandler(req, res);
  });

  // API root / 404.
  app.use('/api', notFound);

  // Built SPA (production) or dev notice.
  if (opts.serveSpa) {
    const spaDir = PATHS.webDist;
    if (fs.existsSync(spaDir)) {
      app.use(express.static(spaDir, { index: false, maxAge: '7d' }));
      app.use((req, res, next) => {
        if (req.path.startsWith('/api') || req.method !== 'GET') {
          next();
          return;
        }
        res.sendFile(path.join(spaDir, 'index.html'));
      });
    }
  }

  app.use(errorHandler);
  return app;
}
