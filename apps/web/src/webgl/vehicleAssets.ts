// vehicleAssets.ts — resolve vehicle GLB urls through the staged /3d manifest
// (guide 06 §11). Falls back to a direct path when assets are unstaged (dev).
export interface ManifestFile {
  url: string;
  bytes: number;
  sha256: string;
}

import type { GraphicsPreset } from './preset';

let cached: Record<string, ManifestFile> | null = null;
let pending: Promise<Record<string, ManifestFile>> | null = null;

export async function getManifest(): Promise<Record<string, ManifestFile>> {
  if (cached) return cached;
  if (!pending) {
    pending = fetch('/3d/manifest.json', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`manifest ${r.status}`);
        const data = (await r.json()) as { files: Record<string, ManifestFile> };
        cached = data.files ?? {};
        return cached;
      })
      .catch(() => ({}));
    void pending.finally(() => {
      pending = null;
    });
  }
  return pending;
}

/** Resolve a base asset name like "compact_sedan" or "compact_sedan_lod". */
export async function resolveAssetUrl(base: string): Promise<string> {
  const files = await getManifest();
  const entry = files[base];
  if (entry?.url) return entry.url;
  return `/assets/models/${base}.glb`;
}

/**
 * R2-62: pick the LOD variant the Blender pipeline emits for a preset —
 * low → _lod2 (most decimated), medium → _lod, high/ultra → LOD0. Every
 * shipped variant is used, none is dead weight.
 */
export function lodBaseFor(vehicleClass: string, preset: GraphicsPreset): string {
  if (preset === 'low') return `${vehicleClass}_lod2`;
  if (preset === 'medium') return `${vehicleClass}_lod`;
  return vehicleClass;
}
