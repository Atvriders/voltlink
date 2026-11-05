// A-KEYROT regression:
// 1. Provider credentials are sealed with envelope v2 + bound AAD.
// 2. Legacy v1 rows stay readable (no silent drop on upgrade).
// 3. A corrupt/unopenable row surfaces an error, never an empty credential.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { sealJson } from '../src/core/crypto';
import {
  saveCredentials,
  loadCredentials,
  buildContext,
} from '../src/providers/registry';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function mkAccount() {
  const user = await prisma.user.create({
    data: {
      email: `akr.${Date.now()}.${randomId().slice(0, 6)}@test.dev`,
      name: 'akr',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: `AKR-${randomId().slice(0, 6)}`,
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  const account = await prisma.providerAccount.create({
    data: {
      organizationId: org.id,
      provider: 'tesla',
      label: 'akr',
      status: 'connected',
      connectedById: user.id,
    },
  });
  return { user, org, account };
}

describe('A-KEYROT credential envelopes', () => {
  it('saves v2 envelopes with AAD and still reads legacy v1 rows', async () => {
    const w = await mkAccount();
    await saveCredentials(w.account.id, { accessToken: 'tok-123', region: 'na' });

    const row = await prisma.providerCredential.findUniqueOrThrow({
      where: { providerAccountId: w.account.id },
    });
    expect(row.algorithm).toBe('aes-256-gcm-envelope-v2');
    expect((JSON.parse(row.ciphertext) as { v: number }).v).toBe(2);

    const back = await loadCredentials(w.account.id);
    expect(back.accessToken).toBe('tok-123');
    expect(back.region).toBe('na');

    // Legacy v1 rows (from an install that predates the ring) stay readable.
    const legacy = sealJson({ accessToken: 'legacy-tok', region: 'na' });
    await prisma.providerCredential.update({
      where: { providerAccountId: w.account.id },
      data: legacy,
    });
    const back2 = await loadCredentials(w.account.id);
    expect(back2.accessToken).toBe('legacy-tok');

    await prisma.organization.delete({ where: { id: w.org.id } });
    await prisma.user.delete({ where: { id: w.user.id } });
  });

  it('surfaces corrupt rows instead of returning empty credentials', async () => {
    const w = await mkAccount();
    await prisma.providerCredential.create({
      data: {
        providerAccountId: w.account.id,
        keyVersion: 1,
        algorithm: 'aes-256-gcm-envelope-v2',
        ciphertext: '{"v":2,"kid":1,"not":"a valid envelope"}',
      },
    });

    await expect(loadCredentials(w.account.id)).rejects.toThrow();

    const account = await prisma.providerAccount.findUniqueOrThrow({
      where: { id: w.account.id },
    });
    await expect(buildContext(account)).rejects.toThrow();

    await prisma.organization.delete({ where: { id: w.org.id } });
    await prisma.user.delete({ where: { id: w.user.id } });
  });
});
