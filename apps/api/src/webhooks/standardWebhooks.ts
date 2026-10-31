// Standard Webhooks signing and verification (N-WHSIGN, guide 03 §5). Signing
// content is `<webhook-id>.<webhook-timestamp>.<body>` with HMAC-SHA256; the
// signature is `v1,<base64>` and multiple signatures are space-separated.

import crypto from 'node:crypto';

export const TOLERANCE_SEC = 300;

export const generateWebhookSecret = () => `whsec_${crypto.randomBytes(32).toString('base64')}`;

function keyBytes(secret: string): Buffer {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  if (key.length < 24 || key.length > 64) throw new Error('webhook secret must decode to 24-64 bytes');
  return key;
}

export function signV1(secret: string, msgId: string, ts: number, body: string | Buffer): string {
  return `v1,${crypto.createHmac('sha256', keyBytes(secret)).update(`${msgId}.${ts}.`).update(body).digest('base64')}`;
}

export function outgoingHeaders(secrets: string[], msgId: string, body: string, now = new Date()): Record<string, string> {
  const ts = Math.floor(now.getTime() / 1000);
  return {
    'content-type': 'application/json',
    'webhook-id': msgId,
    'webhook-timestamp': String(ts),
    'webhook-signature': secrets.map((s) => signV1(s, msgId, ts, body)).join(' '),
  };
}

export type VerifyResult = { ok: true; msgId: string } | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale' | 'bad_signature' };

export function verifyIncoming(
  secrets: string[],
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  nowSec = Math.floor(Date.now() / 1000),
): VerifyResult {
  const one = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const msgId = one('webhook-id');
  const ts = one('webhook-timestamp');
  const sig = one('webhook-signature');
  if (!msgId || !ts || !sig || msgId.length > 256 || sig.length > 4096) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(nowSec - Number(ts)) > TOLERANCE_SEC) return { ok: false, reason: 'stale' };
  const presented = sig.split(' ').filter((p) => p.startsWith('v1,')).map((p) => Buffer.from(p.slice(3), 'base64'));
  for (const s of secrets) {
    let expected: Buffer;
    try {
      expected = Buffer.from(signV1(s, msgId, Number(ts), rawBody).slice(3), 'base64');
    } catch {
      continue; // malformed stored secret: treat as non-matching
    }
    if (presented.some((p) => p.length === expected.length && crypto.timingSafeEqual(p, expected))) return { ok: true, msgId };
  }
  return { ok: false, reason: 'bad_signature' };
}
