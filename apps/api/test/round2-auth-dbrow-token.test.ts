// R4: auth coverage — setup-token DB row path (178-188), bootstrap transaction
// (name default, operator org, audit), double-bootstrap P2002 (250) and the
// no-SMTP REGISTRATION_UNAVAILABLE branch (336). Runs in its own fork with
// VL_SETUP_TOKEN unset so verifySetupToken reads instance.setupTokenHash.
const envs = vi.hoisted(() => {
  delete process.env.VL_SETUP_TOKEN;
  delete process.env.SMTP_URL;
  process.env.NODE_ENV = 'test';
  process.env.MAIL_TO_CONSOLE = 'true';
});
void envs;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, sha256hex } from '../src/core/crypto';
import {
  bootstrapInstanceAdmin,
  registerUser,
  setRegistrationMode,
  setupStatus,
} from '../src/auth/service';
import { ensureSetupToken } from '../src/auth/setup-token';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const TOKEN = 'row-token-0123456789abcdef0123456789';

describe('setup token DB row path', () => {
  it('reports SETUP_TOKEN_REQUIRED while no token row exists', async () => {
    await expect(setupStatus()).resolves.toMatchObject({ needsSetup: false });
    await expect(
      bootstrapInstanceAdmin({
        email: 'a@example.invalid',
        name: 'A',
        password: 'long-enough-123',
        setupToken: TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'SETUP_TOKEN_REQUIRED' });
  });

  it('accepts the stored token hash, defaults the name, and refuses a second bootstrap', async () => {
    await prisma.appSetting.create({
      data: { key: 'instance.setupTokenHash', value: sha256hex(TOKEN) },
    });
    // The worker template is pre-bootstrapped; drop the marker so the first
    // bootstrap below can take the success path.
    await prisma.appSetting.deleteMany({ where: { key: 'instance.bootstrappedAt' } });
    const result = await bootstrapInstanceAdmin({
      email: 'owner@example.invalid',
      name: '   ',
      password: 'long-enough-123',
      setupToken: TOKEN,
    });
    expect(result.user.email).toBe('owner@example.invalid');
    expect(result.user.name).toBe('owner');
    // The first bootstrap consumed the token row; restore it so the second
    // call reaches the duplicate-bootstrap (P2002) guard.
    await prisma.appSetting.upsert({
      where: { key: 'instance.setupTokenHash' },
      update: { value: sha256hex(TOKEN) },
      create: { key: 'instance.setupTokenHash', value: sha256hex(TOKEN) },
    });
    await expect(
      bootstrapInstanceAdmin({
        email: 'second@example.invalid',
        name: 'S',
        password: 'long-enough-123',
        setupToken: TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'SETUP_COMPLETE' });
  });

  it('rejects a wrong token against the stored hash', async () => {
    // Fresh fork DB per file, but the token row was deleted by bootstrap;
    // recreate it for the mismatch assertion.
    await prisma.appSetting.upsert({
      where: { key: 'instance.setupTokenHash' },
      update: { value: sha256hex(TOKEN) },
      create: { key: 'instance.setupTokenHash', value: sha256hex(TOKEN) },
    });
    await expect(
      bootstrapInstanceAdmin({
        email: 'x@example.invalid',
        name: 'X',
        password: 'long-enough-123',
        setupToken: 'wrong-token-9999999999999999999999',
      }),
    ).rejects.toMatchObject({ code: 'SETUP_TOKEN_INVALID' });
  });

  it('refuses open-mode registration while no SMTP is configured', async () => {
    // Bootstrapped + registrationMode=open + no SMTP_URL -> REGISTRATION_UNAVAILABLE.
    await prisma.appSetting.upsert({
      where: { key: 'instance.registrationMode' },
      update: { value: 'open' },
      create: { key: 'instance.registrationMode', value: 'open' },
    });
    await expect(setupStatus()).resolves.toMatchObject({
      needsSetup: false,
      registrationMode: 'open',
    });
    await expect(
      registerUser({
        email: `fresh-${randomId()}@example.invalid`,
        name: 'F',
        password: 'long-enough-123',
      }),
    ).rejects.toMatchObject({ code: 'REGISTRATION_UNAVAILABLE' });
  });

  it('rejects bootstrap with an email that already exists', async () => {
    await prisma.appSetting.upsert({
      where: { key: 'instance.setupTokenHash' },
      update: { value: sha256hex(TOKEN) },
      create: { key: 'instance.setupTokenHash', value: sha256hex(TOKEN) },
    });
    await expect(
      bootstrapInstanceAdmin({
        email: 'test-bootstrap@voltlink.test',
        name: 'T',
        password: 'long-enough-123',
        setupToken: TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
    // ensureSetupToken returns null once the row already exists.
    await expect(ensureSetupToken()).resolves.toBeNull();
  });

  it('falls back to setup/invite registration modes when settings are missing and requires setup', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'instance.registrationMode' } });
    await expect(setupStatus()).resolves.toMatchObject({
      needsSetup: false,
      registrationMode: 'invite',
    });
    await prisma.appSetting.deleteMany({ where: { key: 'instance.bootstrappedAt' } });
    await expect(setupStatus()).resolves.toMatchObject({
      needsSetup: true,
      registrationMode: 'setup',
    });
    await expect(
      registerUser({
        email: `req-${randomId()}@example.invalid`,
        name: 'R',
        password: 'long-enough-123',
      }),
    ).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
  });

  it('refuses open mode without SMTP but accepts other modes', async () => {
    await expect(setRegistrationMode('open')).rejects.toMatchObject({ code: 'SMTP_REQUIRED' });
    await setRegistrationMode('closed');
    const row = await prisma.appSetting.findUniqueOrThrow({
      where: { key: 'instance.registrationMode' },
    });
    expect(row.value).toBe('closed');
  });
});
