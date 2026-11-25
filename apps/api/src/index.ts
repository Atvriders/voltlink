// Web role entrypoint: API + SPA + SSE. Migration leader before serving.

import { env, validateEnv } from './core/env';
import { buildApp } from './app';
import { sseStart, sseStop } from './core/sse';
import { waitForMigrations } from './cli/migrate';
import { prisma } from './core/db';
import { ensureComponents, runStatusChecks } from './status/service';
import { initRedis } from './core/redis';
import { ensureSetupToken } from './auth/setup-token';

async function main(): Promise<void> {
  validateEnv();
  await initRedis();
  await import('./net/policy').then((m) => m.buildOutboundPolicy());
  await waitForMigrations();
  await prisma.$connect();
  await ensureComponents();

  // R2-01: a fresh install without VL_SETUP_TOKEN still gets a way in. The
  // web role generates a fresh token on EVERY boot while setup is pending,
  // hashes it at rest, and logs it with the token as the LAST field of the
  // line (the documented shape), so the guide/CI command
  //   grep 'first-run setup token' | tail -1 | awk '{print $NF}'
  // extracts the token itself. A configured VL_SETUP_TOKEN is never logged.
  const setupToken = await ensureSetupToken();
  if (setupToken) {
    console.log(
      `[voltlink] first-run setup token (complete first-run setup at /setup; this token is reissued on every boot until setup completes) ${setupToken}`,
    );
  }

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

// NEW-05: log and keep serving; never crash a role on a stray rejection.
process.on('unhandledRejection', (reason) => {
  console.error('[voltlink] web unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[voltlink] web uncaughtException:', err);
});
