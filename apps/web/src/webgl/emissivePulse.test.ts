// R2-15: the charge connector is an Object3D pivot in the GLBs — pulsing
// "the connector's material" is a no-op (pivot has none) and the old direct
// `.material.emissive` write crashed for charging vehicles. The pulse must
// reach the connector's DESCENDANT meshes.
import { describe, expect, it } from 'vitest';
import { collectEmissiveMaterials } from './emissivePulse';

function mesh(material?: unknown) {
  return { isMesh: true, material, children: [] };
}

describe('emissive collection (R2-15)', () => {
  it('collects descendant meshes of the connector pivot', () => {
    const pivot = {
      isMesh: false,
      material: undefined,
      children: [
        mesh({ emissive: 'blue' }),
        mesh([{ emissive: 'green' }, { emissive: 'red' }]),
        mesh(undefined),
      ],
    };
    const mats = collectEmissiveMaterials(pivot);
    expect(mats.map((m) => m.emissive)).toEqual(['blue', 'green', 'red']);
  });

  it('returns nothing when no descendant mesh has an emissive material', () => {
    const pivot = {
      isMesh: false,
      material: undefined,
      children: [mesh(undefined), mesh('plain-material')],
    };
    expect(collectEmissiveMaterials(pivot)).toEqual([]);
  });

  it('handles a direct mesh root with a single material', () => {
    const direct = mesh({ emissive: 'cyan' });
    expect(collectEmissiveMaterials(direct)).toEqual([{ emissive: 'cyan' }]);
  });
});
