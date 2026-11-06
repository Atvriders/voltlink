// R4: auth coverage — echoableToken (148). With DEV_ECHO_TOKENS +
// NODE_ENV=development and a localhost PUBLIC_URL the ECHO_OK gate opens, so
// requestPasswordReset prints the token (dev-only behavior).
const envs = vi.hoisted(() => {
  delete process.env.SMTP_URL;
  process.env.NODE_ENV = 'development';
  process.env.VL_DEV_ECHO_TOKENS = 'true';
  process.env.MAIL_TO_CONSOLE = 'true';
  process.env.PUBLIC_URL = 'http://localhost:3000';
  process.env.VL_SETUP_TOKEN = 'cov-setup-token-0123456789abcdef0123456789abcdef';
});
void envs;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { hashPassword, randomId } from '../src/core/crypto';
import { requestPasswordReset } from '../src/auth/service';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('dev echo gate', () => {
  it('logs the reset token when the dev echo gate is open', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const user = await prisma.user.create({
      data: {
        email: `echo-${randomId()}@test.dev`,
        name: 'Echo',
        passwordHash: await hashPassword('long-enough-123'),
        webauthnUserId: randomId(),
      },
    });
    await expect(requestPasswordReset(user.email)).resolves.toEqual({ ok: true });
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith('[mail:dev]'))).toBe(true);
    logSpy.mockRestore();
    await prisma.user.delete({ where: { id: user.id } });
  });
});
