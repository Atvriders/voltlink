// placeholder.test.ts — the boot-time placeholder refusal must catch
// documented placeholder values and NEVER refuse generated keys (a false
// positive locks an install out of its own secret).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { looksLikePlaceholder } from './placeholder';

describe('looksLikePlaceholder', () => {
  it('catches the documented placeholder shapes', () => {
    for (const v of [
      'change-me-db-password',
      'changeme',
      'CHANGE_ME',
      'my-secret',
      'example-value',
      'placeholder-value',
      'your-key-here',
      'xxxxxx',
      'xXxXxXxXxX',
      'the-default-key',
      'default',
    ]) {
      expect(looksLikePlaceholder(v), v).toBe(true);
    }
  });

  it('never refuses generated keys (20,000 base64 and hex keys)', () => {
    for (let i = 0; i < 20_000; i++) {
      const b64 = randomBytes(32).toString('base64');
      const hex = randomBytes(32).toString('hex');
      expect(looksLikePlaceholder(b64), `base64 key #${i} ${b64}`).toBe(false);
      expect(looksLikePlaceholder(hex), `hex key #${i}`).toBe(false);
    }
  });

  it('allows up to five consecutive x characters in a generated key', () => {
    expect(looksLikePlaceholder('KxxxxxQm90LWEtcmVhbC1tYXN0ZXIta2V5IQ')).toBe(false);
    expect(looksLikePlaceholder('AxxxxxB')).toBe(false);
    expect(looksLikePlaceholder('xxxxx')).toBe(false);
  });
});
