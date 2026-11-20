// R2-62: LOD selection must use every shipped variant — low maps to the
// decimated _lod2 asset, medium to _lod, high/ultra to LOD0. The old viewer
// only ever picked '' or '_lod', so the _lod2 assets were dead weight.
import { describe, expect, it } from 'vitest';
import { lodBaseFor } from './vehicleAssets';

describe('LOD asset selection (R2-62)', () => {
  it('maps the low preset to the lod2 variant', () => {
    expect(lodBaseFor('compact_sedan', 'low')).toBe('compact_sedan_lod2');
  });

  it('maps the medium preset to the lod variant', () => {
    expect(lodBaseFor('pickup', 'medium')).toBe('pickup_lod');
  });

  it('keeps LOD0 for high and ultra presets', () => {
    expect(lodBaseFor('suv', 'high')).toBe('suv');
    expect(lodBaseFor('suv', 'ultra')).toBe('suv');
  });
});
