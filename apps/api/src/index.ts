// Web role entrypoint: API + SPA + SSE. Migration leader before serving.

import { env, validateEnv } from './core/env';
import { buildApp } from './app';
import { sseStart, sseStop } from './core/sse';
import { runMigrationLeader } from './cli/migrateLeader';
import { prisma } from './core/db';
import { ensureComponents, runStatusChecks } from './status/service';

async function main(): Promise<void> {
  validateEnv();
  await import('./net/policy').then((m) => m.buildOutboundPolicy());
  await runMigrationLeader();
  await prisma.$connect();
  await ensureComponents();

  const app = buildApp({ serveSpa: true });
  const server = app.listen(env.PORT, env.HOST, () => {
    console.log(`[voltlink] web listening on ${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
  });

  sseStart();
  // Initial status checks + hourly refresh.
  void runStatusChecks().catch(() => undefined);
  const checks = setInterval(() => void runStatusChecks().catch(() => undefined), 3600_000);
  checks.unref();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[voltlink] ${signal} received, draining…`);
    setTimeout(() => {
      sseStop();
      server.close(() => {
        void prisma.$disconnect().then(() => process.exit(0));
      });
      setTimeout(() => process.exit(0), 5000).unref();
    }, 1000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[voltlink] fatal startup error:', err);
  process.exit(1);
});
