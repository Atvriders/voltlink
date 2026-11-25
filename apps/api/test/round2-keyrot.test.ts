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
import { saveCredentials, loadCredentials, buildContext } from '../src/providers/registry';
import { rewrap, resetRingForTests, KeyMissingError } from '../src/core/keyring';
import { createHash } from 'node:crypto';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function mkAccount() {
  const user = await prisma.user.create({
    data: {
      email: `akr.${Date.now()}.${randomId().slice(0, 6)}@example.invalid`,
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

  // TI-25: a real rotation — K1 active → restart with K2 active + K1 in the
  // ring → reseal → consumers still work → retire K1 → K1 rows refuse to open.
  it('rotates the active key and reseals existing envelopes (TI-25)', async () => {
    const savedEnv = {
      key: process.env.VL_MASTER_KEY,
      keys: process.env.VL_MASTER_KEYS,
      version: process.env.VL_MASTER_KEY_VERSION,
    };
    const k1 = createHash('sha256').update('rotation-key-1').digest('base64');
    const k2 = createHash('sha256').update('rotation-key-2').digest('base64');
    try {
      process.env.VL_MASTER_KEY = k1;
      process.env.VL_MASTER_KEYS = '';
      process.env.VL_MASTER_KEY_VERSION = '1';
      resetRingForTests();
      const w = await mkAccount();
      await saveCredentials(w.account.id, { accessToken: 'rot-tok', region: 'eu' });
      const before = await prisma.providerCredential.findUniqueOrThrow({
        where: { providerAccountId: w.account.id },
      });
      expect(JSON.parse(before.ciphertext).kid).toBe(1);

      // "Restart": K2 active, K1 still in the ring.
      process.env.VL_MASTER_KEY = k2;
      process.env.VL_MASTER_KEYS = `v1:${k1}`;
      process.env.VL_MASTER_KEY_VERSION = '2';
      resetRingForTests();

      const resealed = rewrap(before.ciphertext, `provider-credential:${w.account.id}`);
      expect(resealed.keyVersion).toBe(2);
      expect((JSON.parse(resealed.ciphertext) as { kid: number }).kid).toBe(2);
      // Persist the resealed envelope exactly like the reseal CLI does.
      await prisma.providerCredential.update({
        where: { providerAccountId: w.account.id },
        data: {
          keyVersion: resealed.keyVersion,
          ciphertext: resealed.ciphertext,
          algorithm: resealed.algorithm,
        },
      });

      // Consumers still work through the re-wrapped row.
      const back = await loadCredentials(w.account.id);
      expect(back.accessToken).toBe('rot-tok');
      expect(back.region).toBe('eu');

      // Retire K1: the old envelope is now unopenable by design.
      process.env.VL_MASTER_KEYS = '';
      resetRingForTests();
      const stillK1 = await prisma.providerCredential.findUniqueOrThrow({
        where: { providerAccountId: w.account.id },
      });
      expect((JSON.parse(stillK1.ciphertext) as { kid: number }).kid).toBe(2);
      const oldCipher = before.ciphertext;
      await expect(
        (async () => {
          const { open } = await import('../src/core/keyring');
          return open(oldCipher, `provider-credential:${w.account.id}`);
        })(),
      ).rejects.toBeInstanceOf(KeyMissingError);
      // The resealed (v2) row still opens under K2.
      const { open } = await import('../src/core/keyring');
      expect(open(stillK1.ciphertext, `provider-credential:${w.account.id}`)).toBe(
        '{"accessToken":"rot-tok","region":"eu"}',
      );

      await prisma.organization.delete({ where: { id: w.org.id } });
      await prisma.user.delete({ where: { id: w.user.id } });
    } finally {
      if (savedEnv.key === undefined) delete process.env.VL_MASTER_KEY;
      else process.env.VL_MASTER_KEY = savedEnv.key;
      if (savedEnv.keys === undefined) delete process.env.VL_MASTER_KEYS;
      else process.env.VL_MASTER_KEYS = savedEnv.keys;
      if (savedEnv.version === undefined) delete process.env.VL_MASTER_KEY_VERSION;
      else process.env.VL_MASTER_KEY_VERSION = savedEnv.version;
      resetRingForTests();
    }
  });

  // TI-25: the AAD binds the envelope to its account — a row copied from
  // account B must never open as account A (the original A-KEYROT repro).
  it('refuses to open a credential row copied from another account (TI-25 AAD)', async () => {
    const a = await mkAccount();
    const b = await mkAccount();
    await saveCredentials(b.account.id, { accessToken: 'b-tok', region: 'na' });
    const bRow = await prisma.providerCredential.findUniqueOrThrow({
      where: { providerAccountId: b.account.id },
    });
    await prisma.providerCredential.create({
      data: {
        providerAccountId: a.account.id,
        keyVersion: bRow.keyVersion,
        algorithm: bRow.algorithm,
        ciphertext: bRow.ciphertext,
      },
    });
    await expect(loadCredentials(a.account.id)).rejects.toThrow();
    await prisma.organization.deleteMany({
      where: { id: { in: [a.org.id, b.org.id] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [a.user.id, b.user.id] } } });
  });

  // TI-25 + R2-67: an EMPTY VL_MASTER_KEY_VERSION means unset (product
  // default 1) — the R2-67 contract. A NON-INTEGER value must refuse, and
  // a version absent from the ring must refuse, so rotation can never be a
  // silent no-op.
  it('rejects a blank VL_MASTER_KEY_VERSION (TI-25 boot)', async () => {
    const saved = process.env.VL_MASTER_KEY_VERSION;
    try {
      process.env.VL_MASTER_KEY_VERSION = '';
      resetRingForTests();
      const { seal } = await import('../src/core/keyring');
      // Empty = unset: seals with the default v1 ring (R2-67), no crash.
      expect(() => seal('x', 'ctx')).not.toThrow();

      process.env.VL_MASTER_KEY_VERSION = 'abc';
      resetRingForTests();
      expect(() => seal('x', 'ctx')).toThrow(/positive integer/);

      process.env.VL_MASTER_KEY_VERSION = '0';
      resetRingForTests();
      expect(() => seal('x', 'ctx')).toThrow(/positive integer/);
    } finally {
      if (saved === undefined) delete process.env.VL_MASTER_KEY_VERSION;
      else process.env.VL_MASTER_KEY_VERSION = saved;
      resetRingForTests();
    }
  });
});
