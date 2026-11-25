// R4: auth coverage — VL_SETUP_TOKEN shorter than 32 chars (167). Separate
// fork: the env is cached at module import time.
const envs = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.MAIL_TO_CONSOLE = 'true';
  process.env.VL_SETUP_TOKEN = 'short';
});
void envs;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { bootstrapInstanceAdmin } from '../src/auth/service';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('short setup token', () => {
  it('refuses bootstrap with SETUP_TOKEN_REQUIRED', async () => {
    await expect(
      bootstrapInstanceAdmin({
        email: 's@example.invalid',
        name: 'S',
        password: 'long-enough-123',
        setupToken: 'short',
      }),
    ).rejects.toMatchObject({ code: 'SETUP_TOKEN_REQUIRED' });
  });
});
