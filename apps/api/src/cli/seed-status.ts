// seed-status role (guide 08 §11.2): seeds the global status content
// (components, demo incidents, maintenance window, check history) for the
// scripted visual stack. The visual stack runs this once at boot so the
// status pages render the SAME seeded world whether or not a demo fleet has
// been enabled yet — the public page's uptime figures and the admin chart
// never depend on test order.

import { prisma } from '../core/db';
import { waitForMigrations } from './migrate';
import { seedStatusContent } from '../telemetry/seed';

async function main(): Promise<void> {
  await waitForMigrations();
  await prisma.$connect();
  await seedStatusContent();
  console.log('[voltlink] status content seeded');
  await prisma.$disconnect();
}

void main().catch((err) => {
  console.error('[voltlink] seed-status fatal error:', err);
  process.exit(1);
});
