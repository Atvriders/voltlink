// R2-01: first-run setup must always be possible. With VL_SETUP_TOKEN set the
// operator already has a token and the boot log NEVER prints it (a configured
// secret is never echoed). Without it the web role generates a fresh token on
// EVERY boot while setup is still pending — the stored hash is replaced each
// time, so a lost boot log can never lock the owner out (the guide's command
// reads the latest boot's line). After bootstrapInstanceAdmin the hash row is
// deleted and no further token is generated or logged.

import { prisma } from '../core/db';
import { randomToken, sha256hex } from '../core/crypto';

export async function ensureSetupToken(): Promise<string | null> {
  const configured = process.env.VL_SETUP_TOKEN;
  if (configured) return null; // never log a configured secret
  const bootstrapped = await prisma.appSetting.findUnique({
    where: { key: 'instance.bootstrappedAt' },
  });
  if (bootstrapped) return null; // never generate after bootstrap
  const token = randomToken(32);
  await prisma.appSetting.upsert({
    where: { key: 'instance.setupTokenHash' },
    update: { value: sha256hex(token) },
    create: { key: 'instance.setupTokenHash', value: sha256hex(token) },
  });
  return token;
}
