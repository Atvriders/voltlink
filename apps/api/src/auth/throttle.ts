// Durable per-account / per-key throttling shared by all web replicas
// (A-STEPUPTHROTTLE, A-TOTPLOGIN). Failures double from 30 s to 1 h
// (NIST SP 800-63B-4 §3.2.2); 100 failures on a user key lock the account.

import { prisma } from '../core/db';
import { AuthError } from '../authz/errors';
import { sha256hex } from '../core/crypto';

// R2-55: lockout counters are scoped to the account AND the client IP, so a
// remote attacker rotating IPs cannot lock a victim's account. Remote failures
// never lock the account itself (no session termination).
export function userKey(userId: string, ip?: string | null): string {
  return `user:${userId}:ip:${ip ? sha256hex(ip) : 'anon'}`;
}

export async function assertNotThrottled(key: string): Promise<void> {
  const row = await prisma.authThrottle.findUnique({ where: { key } });
  if (row?.lockedUntil && row.lockedUntil > new Date()) {
    throw new AuthError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.', 429);
  }
}

export async function recordFailure(key: string): Promise<void> {
  const row = await prisma.authThrottle.upsert({
    where: { key },
    create: { key, failures: 1 },
    update: { failures: { increment: 1 } },
  });
  if (row.failures >= 5) {
    const sec = Math.min(3600, 30 * 2 ** Math.min(row.failures - 5, 7));
    await prisma.authThrottle.update({
      where: { key },
      data: { lockedUntil: new Date(Date.now() + sec * 1000) },
    });
  }
}

export async function clearFailures(key: string): Promise<void> {
  await prisma.authThrottle.deleteMany({ where: { key } });
}
