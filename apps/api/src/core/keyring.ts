// Envelope v2 key ring with rotation support (A-KEYROT). The ring is the union
// of VL_MASTER_KEYS="v1:<b64>,v2:<b64>" and { [VL_MASTER_KEY_VERSION ?? 1]:
// VL_MASTER_KEY }, with VL_MASTER_KEY_VERSION ?? 1 as the active version.
// v1 envelopes (no AAD, single key) still open for compatibility.

import crypto from 'node:crypto';
import { env } from './env';

const b64 = (b: Buffer) => b.toString('base64');

export class KeyMissingError extends Error {
  kid: number;
  constructor(kid: number) {
    super(`Master key version ${kid} is not in VL_MASTER_KEYS; add it to rotate these rows.`);
    this.kid = kid;
  }
}

function parseRing(): { active: number; keys: Map<number, Buffer> } {
  const keys = new Map<number, Buffer>();
  const raw = env.MASTER_KEY();
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('VL_MASTER_KEY must be 32 bytes when base64-decoded.');
  const active = Number(process.env.VL_MASTER_KEY_VERSION ?? '1');
  if (!Number.isInteger(active) || active < 1) throw new Error('VL_MASTER_KEY_VERSION must be a positive integer.');
  keys.set(active, buf);
  const list = process.env.VL_MASTER_KEYS ?? '';
  if (list) {
    for (const part of list.split(',')) {
      const m = part.trim().match(/^v(\d+):(.+)$/);
      if (!m) throw new Error(`VL_MASTER_KEYS entry ${JSON.stringify(part)} must look like v1:<base64>.`);
      const kid = Number(m[1]);
      const kb = Buffer.from(m[2] ?? '', 'base64');
      if (kb.length !== 32) throw new Error(`VL_MASTER_KEYS v${kid} must be 32 bytes when base64-decoded.`);
      keys.set(kid, kb);
    }
  }
  if (!keys.has(active)) throw new Error(`VL_MASTER_KEY_VERSION=${active} is not present in the key ring.`);
  return { active, keys };
}

let ringCache: { active: number; keys: Map<number, Buffer> } | null = null;
function ring() {
  if (!ringCache) ringCache = parseRing();
  return ringCache;
}

const contextAad = (context: string) => Buffer.from(`voltlink:v2:${context}`);

/** Encrypt `plaintext` into an envelope v2 with bound AAD context. */
export function seal(plaintext: string, context: string): { keyVersion: number; algorithm: string; ciphertext: string } {
  const r = ring();
  const kid = r.active;
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dek, iv).setAAD(contextAad(context));
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const wiv = crypto.randomBytes(12);
  const w = crypto.createCipheriv('aes-256-gcm', r.keys.get(kid)!, wiv).setAAD(Buffer.from(`voltlink:v2:${kid}:${context}`));
  const wrapped = Buffer.concat([w.update(dek), w.final()]);
  const envelope = {
    v: 2,
    kid,
    wiv: b64(wiv),
    wtag: b64(w.getAuthTag()),
    dek: b64(wrapped),
    iv: b64(iv),
    tag: b64(c.getAuthTag()),
    body: b64(body),
  };
  return { keyVersion: kid, algorithm: 'aes-256-gcm-envelope-v2', ciphertext: JSON.stringify(envelope) };
}

function openV2(ciphertext: string, context: string): string {
  const envl = JSON.parse(ciphertext) as Record<string, unknown>;
  const kid = Number(envl.kid);
  const key = ring().keys.get(kid);
  if (!key) throw new KeyMissingError(kid);
  const wiv = Buffer.from(String(envl.wiv), 'base64');
  const wtag = Buffer.from(String(envl.wtag), 'base64');
  const dekB = Buffer.from(String(envl.dek), 'base64');
  const iv = Buffer.from(String(envl.iv), 'base64');
  const tag = Buffer.from(String(envl.tag), 'base64');
  const body = Buffer.from(String(envl.body), 'base64');
  const w = crypto.createDecipheriv('aes-256-gcm', key, wiv).setAAD(Buffer.from(`voltlink:v2:${kid}:${context}`));
  w.setAuthTag(wtag);
  const dek = Buffer.concat([w.update(dekB), w.final()]);
  const c = crypto.createDecipheriv('aes-256-gcm', dek, iv).setAAD(contextAad(context));
  c.setAuthTag(tag);
  return Buffer.concat([c.update(body), c.final()]).toString('utf8');
}

/** Decrypt any supported envelope back into the original UTF-8 string. */
export function open(ciphertext: string, context: string): string {
  let parsed: { v?: number };
  try {
    parsed = JSON.parse(ciphertext) as { v?: number };
  } catch {
    throw new Error('Invalid sealed value');
  }
  if (parsed.v === 2) return openV2(ciphertext, context);
  // Legacy v1 envelope: no AAD, key v1. Import lazily to avoid a cycle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const legacy = require('./crypto') as typeof import('./crypto');
  return legacy.openEnvelope(ciphertext);
}

/** Re-wrap a sealed value under the active kid (body untouched). v1 becomes v2. */
export function rewrap(ciphertext: string, context: string): { keyVersion: number; algorithm: string; ciphertext: string } {
  let parsed: { v?: number; kid?: number };
  try {
    parsed = JSON.parse(ciphertext) as { v?: number; kid?: number };
  } catch {
    throw new Error('Invalid sealed value');
  }
  if (parsed.v === 2 && parsed.kid === ring().active) return { keyVersion: parsed.kid, algorithm: 'aes-256-gcm-envelope-v2', ciphertext };
  return seal(open(ciphertext, context), context);
}

/** Counts per kid for the rotation CLI and the admin status page. */
export function ringSummary(): { active: number; versions: number[] } {
  const r = ring();
  return { active: r.active, versions: [...r.keys.keys()].sort((a, b) => a - b) };
}
