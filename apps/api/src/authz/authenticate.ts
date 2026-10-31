// Session and API-key authentication. Produces an Actor; never trusts a
// client-supplied role, organization id or VIN.

import type { Request } from 'express';
import { prisma } from '../core/db';
import { env } from '../core/env';
import { sha256hex } from '../core/crypto';
import { verifySessionJwt, tokenHash } from '../auth/service';
import { AuthError, AccessDenied } from './errors';
import type { ApiScope } from '@voltlink/shared';

const API_KEY_RE = /^vlk_[a-z0-9]{12}_[0-9a-f]{64}$/;

function readSessionToken(req: Request): string {
  const cookie = req.cookies?.[env.SESSION_COOKIE] as string | undefined;
  if (typeof cookie === 'string' && cookie) return cookie;
  const auth = req.header('authorization') ?? '';
  if (auth.startsWith('Bearer ') && !auth.slice(7).startsWith('vlk_')) return auth.slice(7);
  return '';
}

export async function authenticateApiKey(token: string, ip?: string) {
  if (!API_KEY_RE.test(token)) throw new AuthError('API_KEY_INVALID', 'Invalid API key.', 401);
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: sha256hex(token) },
    include: { user: true },
  });
  const member =
    key && key.userId
      ? await prisma.membership.findUnique({
          where: {
            organizationId_userId: { organizationId: key.organizationId, userId: key.userId },
          },
        })
      : null;
  if (
    !key ||
    key.revokedAt ||
    key.expiresAt <= new Date() ||
    key.user.suspendedAt ||
    key.user.deletionRequestedAt ||
    member?.status !== 'ACTIVE'
  ) {
    throw new AuthError('API_KEY_INVALID', 'Invalid API key.', 401);
  }
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    void prisma.apiKey
      .update({
        where: { id: key.id },
        data: { lastUsedAt: new Date(), lastUsedIp: ip?.slice(0, 64) },
      })
      .catch(() => undefined);
  }
  return {
    kind: 'apiKey' as const,
    userId: key.userId,
    apiKeyId: key.id,
    organizationId: key.organizationId,
    scopes: (key.scopes ?? []) as unknown as readonly ApiScope[],
    isInstanceAdmin: false as const,
    emailVerified: !!key.user.emailVerifiedAt,
  };
}

/**
 * Authenticate a request. `mode: 'session'` rejects API keys; `mode: 'any'`
 * accepts a session cookie or a `vlk_` bearer key, but never both at once.
 */
export async function authenticate(req: Request, mode: 'session' | 'any' = 'any') {
  const header = req.header('authorization') ?? '';
  if (header.startsWith('Bearer vlk_')) {
    if (mode === 'session')
      throw new AccessDenied(
        'API_KEY_NOT_ALLOWED',
        'This endpoint requires an interactive session.',
        403,
      );
    const cookie = req.cookies?.[env.SESSION_COOKIE];
    if (cookie)
      throw new AuthError(
        'AMBIGUOUS_CREDENTIALS',
        'Send a session cookie or an API key, not both.',
        400,
      );
    return authenticateApiKey(header.slice(7), req.ip);
  }

  const token = readSessionToken(req);
  if (!token) throw new AuthError('UNAUTHENTICATED', 'Sign in to continue.', 401);
  let sid: string;
  try {
    sid = verifySessionJwt(token).sid;
  } catch {
    throw new AuthError('SESSION_EXPIRED', 'Sign in again.', 401);
  }
  const s = await prisma.userSession.findUnique({
    where: { id: sid },
    include: { user: { include: { _count: { select: { passkeys: true } } } } },
  });
  if (
    !s ||
    s.revokedAt ||
    s.expiresAt < new Date() ||
    s.tokenHash !== tokenHash(token) ||
    s.user.suspendedAt ||
    s.user.deletionRequestedAt ||
    s.user.lockedAt
  ) {
    throw new AuthError('SESSION_REVOKED', 'This session was revoked or expired.', 401);
  }
  if (!s.lastSeenAt || Date.now() - s.lastSeenAt.getTime() > 300_000) {
    void prisma.userSession
      .update({ where: { id: s.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }
  return {
    kind: 'session' as const,
    userId: s.userId,
    sessionId: s.id,
    isInstanceAdmin: s.user.isInstanceAdmin,
    emailVerified: !!s.user.emailVerifiedAt,
    mfaEnrolled: s.user.totpEnabled || s.user._count.passkeys > 0,
    stepUpAt: s.stepUpAt,
    stepUpMethod: (s.stepUpMethod ?? null) as
      'password' | 'totp' | 'recovery_code' | 'passkey' | null,
  };
}
