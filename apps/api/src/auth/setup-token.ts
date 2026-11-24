// R2-01: first-run setup must always be possible. With VL_SETUP_TOKEN set the
// operator already has a token; without it the web role generates one at boot,
// persists only its hash, and logs the plaintext exactly once. The boot log is
// the operator's only copy — after bootstrapInstanceAdmin runs, the hash row is
// deleted and the token stops working.

import { prisma } from '../core/db';
import { randomToken, sha256hex } from '../core/crypto';

export async function ensureSetupToken(): Promise<string | null> {
  const configured = process.env.VL_SETUP_TOKEN;
  if (configured) return configured;
  // TI-53: once the instance is bootstrapped, no further setup token may be
  // generated (the old code only checked for a leftover hash row, which
  // bootstrap consumes — so every later boot leaked and logged a fresh token).
  const bootstrapped = await prisma.appSetting.findUnique({
    where: { key: 'instance.bootstrappedAt' },
  });
  if (bootstrapped) return null;
  const existing = await prisma.appSetting.findUnique({
    where: { key: 'instance.setupTokenHash' },
  });
  if (existing) return null; // already generated on an earlier boot
  const token = randomToken(32);
  await prisma.appSetting.create({
    data: { key: 'instance.setupTokenHash', value: sha256hex(token) },
  });
  return token;
}
