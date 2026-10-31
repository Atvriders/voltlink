// One-off, idempotent data tasks that run right after `prisma migrate deploy`
// under the same advisory lock (guide 05 §3). Keyed by DataTask.name, so each
// runs exactly once per database.

import { prisma } from '../core/db';
import { getQueue } from '../core/queue';
import { rewrap } from '../core/keyring';

async function resealSecretsV2(): Promise<void> {
  // Re-seal every stored credential and TOTP secret into envelope v2 under the
  // active key (A-KEYROT). Idempotent: rewrap returns the same ciphertext when
  // the active kid already wraps it.
  const creds = await prisma.providerCredential.findMany();
  for (const c of creds) {
    const context = `provider-credential:${c.providerAccountId}`;
    const next = rewrap(c.ciphertext, context);
    if (next.ciphertext !== c.ciphertext) {
      await prisma.providerCredential.update({
        where: { id: c.id },
        data: {
          keyVersion: next.keyVersion,
          algorithm: next.algorithm,
          ciphertext: next.ciphertext,
        },
      });
    }
  }
  const users = await prisma.user.findMany({
    where: { totpSecretSealed: { not: null } },
    select: { id: true, totpSecretSealed: true },
  });
  for (const u of users) {
    if (!u.totpSecretSealed) continue;
    const context = `totp:${u.id}`;
    const next = rewrap(u.totpSecretSealed, context);
    if (next.ciphertext !== u.totpSecretSealed) {
      await prisma.user.update({
        where: { id: u.id },
        data: { totpSecretSealed: next.ciphertext },
      });
    }
  }
}

async function enqueueZoneRedaction(): Promise<void> {
  // Existing history was never redacted: enqueue a retroactive job per enabled
  // zone (guide 05 §7.2). The queue may be unavailable at migration time on a
  // web-only boot; the worker role re-runs these tasks and will pick it up.
  const zones = await prisma.privacyZone.findMany({
    where: { enabled: true },
    select: { id: true },
  });
  for (const z of zones) {
    try {
      await getQueue().enqueue('privacy-redaction', { zoneId: z.id }, { delayMs: 60_000 });
    } catch {
      return; // queue unavailable — task stays unapplied and retries next boot
    }
  }
}

const TASKS: { name: string; run: () => Promise<void> }[] = [
  { name: '2026-11-reseal-secrets-v2', run: resealSecretsV2 },
  { name: '2026-11-redact-existing-zones', run: enqueueZoneRedaction },
];

export async function runDataTasks(): Promise<void> {
  for (const task of TASKS) {
    const applied = await prisma.dataTask.findUnique({ where: { name: task.name } });
    if (applied) continue;
    await task.run();
    await prisma.dataTask.create({ data: { name: task.name } });
  }
}
