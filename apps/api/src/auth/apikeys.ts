// Scoped API keys (NEW-01): `vlk_<12 char public id>_<64 hex secret>`, stored
// hashed, prefix-identifiable, expiring, audited.

import crypto from 'node:crypto';
import { prisma } from '../core/db';
import { sha256hex } from '../core/crypto';
import { AuthError } from '../authz/errors';
import type { ApiScope } from '@voltlink/shared';

export function mintApiKey() {
  const publicId = Array.from(
    { length: 12 },
    () => 'abcdefghijklmnopqrstuvwxyz0123456789'[crypto.randomInt(36)],
  ).join('');
  const token = `vlk_${publicId}_${crypto.randomBytes(32).toString('hex')}`;
  return { token, prefix: `vlk_${publicId}`, keyHash: sha256hex(token) };
}

export async function createApiKey(input: {
  userId: string;
  organizationId: string;
  name: string;
  scopes: ApiScope[];
  expiresInDays: number;
}): Promise<{
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  expiresAt: string;
  token: string;
}> {
  const days = Math.min(365, Math.max(1, Math.round(input.expiresInDays)));
  const { token, prefix, keyHash } = mintApiKey();
  const row = await prisma.apiKey.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      name: input.name.trim().slice(0, 64),
      keyHash,
      prefix,
      scopes: JSON.parse(JSON.stringify(input.scopes)),
      expiresAt: new Date(Date.now() + days * 86_400_000),
    },
  });
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: input.scopes,
    expiresAt: row.expiresAt.toISOString(),
    token,
  };
}

export async function revokeApiKey(userId: string, apiKeyId: string): Promise<void> {
  const row = await prisma.apiKey.findUnique({ where: { id: apiKeyId } });
  if (!row || row.userId !== userId) throw new AuthError('NOT_FOUND', 'API key not found.', 404);
  await prisma.apiKey.update({ where: { id: apiKeyId }, data: { revokedAt: new Date() } });
}
