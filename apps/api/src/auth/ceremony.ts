// Auth ceremonies: server-side challenges keyed to an HttpOnly `vl_ceremony`
// cookie, single use, with per-account attempt limits (A-TOTPLOGIN, A-PASSKEY).

import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from '../core/db';
import { env } from '../core/env';
import { sha256hex } from '../core/crypto';
import { AuthError } from '../authz/errors';

export const CEREMONY_COOKIE = 'vl_ceremony';
export const PURPOSES = ['mfa_login', 'passkey_login', 'passkey_register', 'stepup_passkey'] as const;
export type CeremonyPurpose = (typeof PURPOSES)[number];

export async function createCeremony(
  res: Response,
  input: { purpose: CeremonyPurpose; userId?: string; sessionId?: string; challenge?: string },
): Promise<string> {
  const handle = crypto.randomBytes(32).toString('hex');
  await prisma.authChallenge.create({
    data: {
      handleHash: sha256hex(handle),
      purpose: input.purpose,
      userId: input.userId,
      sessionId: input.sessionId,
      challenge: input.challenge,
      expiresAt: new Date(Date.now() + 300_000),
    },
  });
  res.cookie(CEREMONY_COOKIE, handle, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: 300_000,
  });
  return handle;
}

export async function readCeremony(req: Request, purpose: CeremonyPurpose) {
  const handle = req.cookies?.[CEREMONY_COOKIE] as string | undefined;
  if (typeof handle !== 'string' || !handle) throw new AuthError('MFA_EXPIRED', 'Start the sign-in again.', 401);
  const row = await prisma.authChallenge.findUnique({ where: { handleHash: sha256hex(handle) } });
  if (!row || row.consumedAt || row.expiresAt < new Date() || row.purpose !== purpose) {
    throw new AuthError('MFA_EXPIRED', 'Start the sign-in again.', 401);
  }
  return row;
}

/** Single-use consumption; the winner gets the row. */
export async function consumeCeremony(req: Request, purpose: CeremonyPurpose) {
  const row = await readCeremony(req, purpose);
  const winner = await prisma.authChallenge.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (winner.count !== 1) throw new AuthError('MFA_EXPIRED', 'This step was already used; start again.', 401);
  return row;
}
