import { beforeEach, describe, expect, it } from 'vitest';
import { fToC, haversineKm, kmToMi, miToKm } from './geo';
import {
  openEnvelope,
  openJson,
  sealEnvelope,
  sealJson,
  sha256hex,
  verifyPassword,
  hashPassword,
} from './crypto';
import { csv, clamp, parseJson } from './util';

beforeEach(() => {
  process.env.VL_MASTER_KEY = 'MWY0MjZiYTc5OGIxMzQ3M2FkYTlmNjJmYzM3M2I0YzQ='; // 32 bytes
});

describe('envelope encryption', () => {
  it('round-trips plaintext', () => {
    const e = sealEnvelope('provider-secret-token');
    expect(e.keyVersion).toBe(1);
    expect(openEnvelope(e.ciphertext)).toBe('provider-secret-token');
  });

  it('round-trips JSON objects', () => {
    const e = sealJson({ tokens: ['a'], ts: 123 });
    expect(openJson<{ tokens: string[]; ts: number }>(e.ciphertext)).toEqual({
      tokens: ['a'],
      ts: 123,
    });
  });

  it('produces different ciphertext each time (random DEK/IV)', () => {
    const a = sealEnvelope('same');
    const b = sealEnvelope('same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(openEnvelope(a.ciphertext)).toBe('same');
    expect(openEnvelope(b.ciphertext)).toBe('same');
  });

  it('rejects tampered envelopes', () => {
    const e = sealEnvelope('secret');
    const obj = JSON.parse(e.ciphertext) as { body: string };
    obj.body = Buffer.from('tampered!').toString('base64');
    expect(() => openEnvelope(JSON.stringify(obj))).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => openEnvelope('not-json')).toThrow(/Invalid credential envelope/);
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toContain('$argon2id$');
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('wrong hash shape returns false, not throw', async () => {
    expect(await verifyPassword('garbage', 'x')).toBe(false);
  });
});

describe('geo & units', () => {
  it('haversine: 1 degree latitude ≈ 111.2 km', () => {
    const d = haversineKm(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110.5);
    expect(d).toBeLessThan(112);
  });

  it('haversine: same point is zero', () => {
    expect(haversineKm(39, -104, 39, -104)).toBe(0);
  });

  it('haversine is symmetric', () => {
    expect(haversineKm(39, -104, 40, -105)).toBeCloseTo(haversineKm(40, -105, 39, -104), 6);
  });

  it('mile conversions round-trip', () => {
    expect(miToKm(kmToMi(10))).toBeCloseTo(10, 6);
    expect(fToC(212)).toBeCloseTo(100);
  });
});

describe('csv & util', () => {
  it('escapes commas and quotes', () => {
    const out = csv([['a,b', 'say "hi"']]);
    expect(out).toContain('"a,b"');
    expect(out).toContain('"say ""hi"""');
  });

  it('builds rows with header', () => {
    const out = csv([
      ['name', 'km'],
      ['A', '1'],
      ['B, Inc', '2'],
    ]);
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('name,km');
    expect(lines[1]).toBe('A,1');
    expect(lines[2]).toBe('"B, Inc",2');
  });

  it('clamp bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(13, 0, 10)).toBe(10);
  });

  it('parseJson falls back on garbage', () => {
    expect(parseJson('{"a":1}', null)).toEqual({ a: 1 });
    expect(parseJson('nope', 'fb')).toBe('fb');
  });
});

describe('sha256', () => {
  it('is deterministic and hex', () => {
    expect(sha256hex('voltlink')).toBe(sha256hex('voltlink'));
    expect(sha256hex('voltlink')).toMatch(/^[0-9a-f]{64}$/);
  });
});
