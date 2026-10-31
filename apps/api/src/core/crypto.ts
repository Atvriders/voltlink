// Password hashing and envelope encryption utilities.

import argon2 from 'argon2';
import crypto from 'node:crypto';
import { env } from './env';

// ---- Passwords ----

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain).catch(() => false);
}

export function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId(): string {
  return crypto.randomBytes(12).toString('hex');
}

// ---- Envelope encryption ----
//
// Master key (VL_MASTER_KEY, base64, 32 bytes) wraps a random data-encryption
// key per credential blob. The stored record carries a key version so future
// master-key rotation can re-wrap DEKs without touching provider data.

const KEY_VERSION = 1;
const ALGORITHM = 'aes-256-gcm-envelope-v1';

function masterKey(): Buffer {
  const raw = env.MASTER_KEY();
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('VL_MASTER_KEY must be 32 bytes when base64-decoded.');
  return buf;
}

/** Encrypt `plaintext` (UTF-8 string) into a versioned envelope. */
export function sealEnvelope(plaintext: string): {
  keyVersion: number;
  algorithm: string;
  ciphertext: string;
} {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // wrap DEK with master key
  const wiv = crypto.randomBytes(12);
  const wcipher = crypto.createCipheriv('aes-256-gcm', masterKey(), wiv);
  const wrapped = Buffer.concat([wcipher.update(dek), wcipher.final()]);
  const wtag = wcipher.getAuthTag();
  const envelope = {
    v: KEY_VERSION,
    alg: 'A256GCM',
    wrapAlg: 'A256GCMKW',
    wiv: wiv.toString('base64'),
    wtag: wtag.toString('base64'),
    dek: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    body: body.toString('base64'),
  };
  return { keyVersion: KEY_VERSION, algorithm: ALGORITHM, ciphertext: JSON.stringify(envelope) };
}

/** Decrypt a versioned envelope back into the original UTF-8 string. */
export function openEnvelope(ciphertext: string): string {
  let envl: Record<string, string>;
  try {
    envl = JSON.parse(ciphertext);
  } catch {
    throw new Error('Invalid credential envelope');
  }
  if (String(envl.v) !== String(KEY_VERSION)) {
    throw new Error(
      `Unsupported envelope key version ${envl.v} — rotate keys or restore the original master key.`,
    );
  }
  const wiv = envl.wiv;
  const wtag = envl.wtag;
  const dekB64 = envl.dek;
  const iv = envl.iv;
  const tag = envl.tag;
  const body = envl.body;
  if (!wiv || !wtag || !dekB64 || !iv || !tag || !body)
    throw new Error('Invalid credential envelope');
  const wcipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(wiv, 'base64'));
  wcipher.setAuthTag(Buffer.from(wtag, 'base64'));
  const dek = Buffer.concat([wcipher.update(Buffer.from(dekB64, 'base64')), wcipher.final()]);

  const cipher = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(iv, 'base64'));
  cipher.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]);
  return out.toString('utf8');
}

/** Encrypt a JSON-serializable object. */
export function sealJson<T>(obj: T): { keyVersion: number; algorithm: string; ciphertext: string } {
  return sealEnvelope(JSON.stringify(obj));
}

/** Decrypt an envelope back into the original object. */
export function openJson<T>(ciphertext: string): T {
  return JSON.parse(openEnvelope(ciphertext)) as T;
}
