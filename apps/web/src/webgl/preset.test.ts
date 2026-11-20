// R2-62: the 'ao' preset flag was shipped but never read by the viewer —
// presets must only declare what the renderer actually honours (pxRatio,
// shadows), so the settings are not lies.
import { describe, expect, it } from 'vitest';
import { PRESETS } from './preset';

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
