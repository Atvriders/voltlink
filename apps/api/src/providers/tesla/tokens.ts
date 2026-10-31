// Token lifecycle and refresh rotation (guide 01 §4, P-TESLAREFRESH).
// Refresh tokens are single-use; the rotation is persisted under a per-account
// row lock so concurrent workers issue exactly one refresh call.

import { prisma } from '../../core/db';
import { openJson, sealJson } from '../../core/crypto';
import { teslaConfig } from './config';
import { classify, TeslaApiError } from './classify';

const SKEW_MS = 5 * 60_000;

export interface TeslaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scopes?: string[];
}

type Cred = { version: number; creds: TeslaTokens };

async function readCreds(
  db: { providerCredential: typeof prisma.providerCredential },
  accountId: string,
): Promise<Cred> {
  const row = await db.providerCredential.findUnique({ where: { providerAccountId: accountId } });
  if (!row) throw new Error(`No credentials stored for Tesla account ${accountId}`);
  const creds = openJson<TeslaTokens>(row.ciphertext);
  return { version: row.keyVersion, creds };
}

export async function getValidAccessToken(
  accountId: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  const snap = await readCreds(prisma, accountId);
  if (!opts.force && snap.creds.expiresAt - Date.now() > SKEW_MS) return snap.creds.accessToken;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ProviderCredential" WHERE "providerAccountId" = ${accountId} FOR UPDATE`;
        const cur = await readCreds(tx, accountId);
        if (
          cur.version !== snap.version ||
          (!opts.force && cur.creds.expiresAt - Date.now() > SKEW_MS)
        ) {
          return cur.creds.accessToken; // another worker rotated first
        }
        const next = await refreshTokens(cur.creds.refreshToken);
        const sealed = sealJson({
          accessToken: next.accessToken,
          refreshToken: next.refreshToken || cur.creds.refreshToken,
          expiresAt: next.expiresAt,
          scopes: next.scopes,
        });
        await tx.providerCredential.update({
          where: { providerAccountId: accountId },
          data: {
            ...sealed,
            keyVersion: { increment: 1 },
          },
        });
        await tx.providerAccount.update({
          where: { id: accountId },
          data: {
            tokenExpiresAt: new Date(next.expiresAt),
            status: 'connected',
            lastErrorCode: null,
          },
        });
        return next.accessToken;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  } catch (err) {
    if (err instanceof TeslaApiError && err.category === 'reauth_required') {
      await markReauthRequired(accountId, err.detail || 'login_required');
    }
    throw err; // network/5xx: keep old tokens, account backoff
  }
}

async function refreshTokens(refreshToken: string): Promise<TeslaTokens> {
  const cfg = teslaConfig();
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      audience: cfg.defaultAudience,
    }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const e = classify(res.status, text, res.headers);
    if (e.category === 'token_expired') throw classify(401, 'login_required', new Headers());
    throw e;
  }
  const body = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  if (!body.access_token) throw new Error('Tesla refresh response has no access_token');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    expiresAt: Date.now() + Number(body.expires_in || 28800) * 1000,
    scopes: body.scope ? body.scope.split(/\s+/) : undefined,
  };
}

/** invalid_grant / login_required → reauth_required + one in-app notification. */
export async function markReauthRequired(accountId: string, code: string): Promise<void> {
  const account = await prisma.providerAccount.findUnique({ where: { id: accountId } });
  if (!account) return;
  await prisma.providerAccount.update({
    where: { id: accountId },
    data: { status: 'reauth_required', lastErrorCode: code.slice(0, 64) },
  });
  if (account.connectedById) {
    const { notify } = await import('../../notifications/service');
    await notify({
      userId: account.connectedById,
      event: 'system',
      severity: 'warning',
      title: 'Tesla re-connect needed',
      body: 'Tesla rejected the stored authorization. Reconnect the account to keep the fleet live.',
      channels: ['in_app'],
      force: true,
    }).catch(() => undefined);
  }
}

/** scp claim from the JWT (base64url decode, no signature verification — read-only display). */
export function scopesFromJwt(accessToken: string): string[] {
  try {
    const payload = accessToken.split('.')[1]!;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const parsed = JSON.parse(json) as { scp?: string[] };
    return Array.isArray(parsed.scp) ? parsed.scp : [];
  } catch {
    return [];
  }
}
