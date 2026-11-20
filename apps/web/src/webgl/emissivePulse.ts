// emissivePulse.ts — R2-15: find every emissive material BELOW the charge
// connector pivot (the connector itself is an Object3D with no material), so
// the charging pulse actually lights the connector meshes instead of writing
// to a missing material or crashing for charging vehicles.
export interface EmissiveLike {
  emissive: unknown;
}

export function collectEmissiveMaterials(root: unknown): EmissiveLike[] {
  const out: EmissiveLike[] = [];
  const visit = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    const obj = o as {
      isMesh?: boolean;
      material?: unknown;
      children?: unknown[];
    };
    if (obj.isMesh && obj.material !== undefined && obj.material !== null) {
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of list) {
        if (m && typeof m === 'object' && 'emissive' in m) {
          out.push(m as EmissiveLike);
        }
      }
    }
    for (const c of obj.children ?? []) visit(c);
  };
  visit(root);
  return out;
}
