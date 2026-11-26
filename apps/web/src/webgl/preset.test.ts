// R2-62: the 'ao' preset flag was shipped but never read by the viewer —
// presets must only declare what the renderer actually honours (pxRatio,
// shadows), so the settings are not lies.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoPreset, PRESETS } from './preset';

describe('graphics presets (R2-62)', () => {
  it('declares only the honoured knobs', () => {
    for (const [name, cfg] of Object.entries(PRESETS)) {
      expect(Object.keys(cfg).sort(), name).toEqual(['pxRatio', 'shadows']);
    }
  });

  it('keeps pxRatio ascending with quality', () => {
    expect(PRESETS.low.pxRatio).toBeLessThan(PRESETS.medium.pxRatio);
    expect(PRESETS.medium.pxRatio).toBeLessThan(PRESETS.high.pxRatio);
    expect(PRESETS.high.pxRatio).toBeLessThan(PRESETS.ultra.pxRatio);
  });
});

describe('autoPreset (R2-62 heuristic)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const withCapability = (hardwareConcurrency?: number, deviceMemory?: number) =>
    vi.stubGlobal('navigator', { hardwareConcurrency, deviceMemory });

  it('is medium without a navigator (SSR safety)', () => {
    vi.stubGlobal('navigator', undefined);
    expect(autoPreset()).toBe('medium');
  });

  it('picks low on small hosts (<=4 cores or <=2 GB)', () => {
    withCapability(4, 4);
    expect(autoPreset()).toBe('low');
    withCapability(16, 2);
    expect(autoPreset()).toBe('low');
  });

  it('picks medium on mid hosts (5-8 cores)', () => {
    withCapability(8, 4);
    expect(autoPreset()).toBe('medium');
  });

  it('picks high on 9-16 cores with >4 GB', () => {
    withCapability(16, 8);
    expect(autoPreset()).toBe('high');
  });

  it('picks ultra above 16 cores with >4 GB', () => {
    withCapability(32, 8);
    expect(autoPreset()).toBe('ultra');
  });

  it('caps a many-core host at medium when memory is only 4 GB', () => {
    withCapability(32, 4);
    expect(autoPreset()).toBe('medium');
  });

  it('treats a missing deviceMemory as 4 GB', () => {
    withCapability(32, undefined);
    expect(autoPreset()).toBe('medium');
  });
});
