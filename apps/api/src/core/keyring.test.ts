import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetRingForTests, validateKeyRing } from './keyring';

const KEY = Buffer.alloc(32, 7).toString('base64');

afterEach(() => {
  vi.unstubAllEnvs();
  resetRingForTests();
});

describe('keyring (R2-67)', () => {
  it('treats an EMPTY VL_MASTER_KEY_VERSION as unset (the compose empty default)', () => {
    vi.stubEnv('VL_MASTER_KEY', KEY);
    vi.stubEnv('VL_MASTER_KEY_VERSION', '');
    expect(() => validateKeyRing()).not.toThrow();
  });

  it('accepts the default version 1 ring', () => {
    vi.stubEnv('VL_MASTER_KEY', KEY);
    vi.stubEnv('VL_MASTER_KEY_VERSION', '');
    expect(() => validateKeyRing()).not.toThrow();
  });

  it('rejects a non-positive version at boot', () => {
    vi.stubEnv('VL_MASTER_KEY', KEY);
    vi.stubEnv('VL_MASTER_KEY_VERSION', '0');
    expect(() => validateKeyRing()).toThrow(/VL_MASTER_KEY_VERSION must be a positive integer/);
  });

  it('rejects a malformed VL_MASTER_KEYS entry at boot', () => {
    vi.stubEnv('VL_MASTER_KEY', KEY);
    vi.stubEnv('VL_MASTER_KEYS', 'v1nocolon');
    expect(() => validateKeyRing()).toThrow(/must look like v1:<base64>/);
  });

  it('accepts a rotated ring with a valid active version', () => {
    vi.stubEnv('VL_MASTER_KEY', KEY);
    vi.stubEnv('VL_MASTER_KEYS', `v2:${Buffer.alloc(32, 9).toString('base64')}`);
    vi.stubEnv('VL_MASTER_KEY_VERSION', '2');
    expect(() => validateKeyRing()).not.toThrow();
  });
});
