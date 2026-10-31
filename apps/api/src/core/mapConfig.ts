// F-MAPGRID: operator-configured basemaps, parsed once at boot with zod and
// failed fast. demo = fictional grid (air-gapped safe), pmtiles = self-hosted
// Protomaps over the app's /tiles mount, style = arbitrary operator style URL.
import { z } from 'zod';

const schema = z
  .object({
    VL_MAP_MODE: z.enum(['demo', 'pmtiles', 'style']).default('demo'),
    VL_MAP_STYLE_URL: z.string().optional(),
    VL_MAP_PMTILES_URL: z.string().optional(),
    VL_MAP_ASSETS_URL: z.string().default('/tiles/assets'),
    VL_MAP_ATTRIBUTION: z.string().optional(),
    VL_MAP_TILES_DIR: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.VL_MAP_MODE === 'style' && !v.VL_MAP_STYLE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'VL_MAP_STYLE_URL is required when VL_MAP_MODE=style',
      });
    }
    if (v.VL_MAP_MODE === 'pmtiles' && !v.VL_MAP_PMTILES_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'VL_MAP_PMTILES_URL is required when VL_MAP_MODE=pmtiles',
      });
    }
  });

export interface MapConfig {
  mode: 'demo' | 'pmtiles' | 'style';
  styleUrl?: string;
  pmtilesUrl?: string;
  assetsUrl: string;
  attribution?: string;
  tilesDir?: string;
  /** origins (scheme://host[:port]) that the CSP must allow for img/connect */
  cspOrigins: string[];
  /** the object served to the SPA by GET /api/v1/config/client */
  client: {
    mode: 'demo' | 'pmtiles' | 'style';
    styleUrl?: string;
    pmtilesUrl?: string;
    assetsUrl: string;
    attribution?: string;
  };
}

export function loadMapConfig(env: NodeJS.ProcessEnv): MapConfig {
  const parsed = schema.parse(env);
  const origins = new Set<string>();
  const addOrigin = (raw: string) => {
    try {
      if (/^https?:\/\//.test(raw)) origins.add(new URL(raw).origin);
    } catch {
      /* invalid URLs fail in zod for styleUrl; pmtiles may be app-relative */
    }
  };
  addOrigin(parsed.VL_MAP_STYLE_URL ?? '');
  addOrigin(parsed.VL_MAP_PMTILES_URL ?? '');
  addOrigin(parsed.VL_MAP_ASSETS_URL ?? '');
  return {
    mode: parsed.VL_MAP_MODE,
    styleUrl: parsed.VL_MAP_STYLE_URL,
    pmtilesUrl: parsed.VL_MAP_PMTILES_URL,
    assetsUrl: parsed.VL_MAP_ASSETS_URL,
    attribution: parsed.VL_MAP_ATTRIBUTION,
    tilesDir: parsed.VL_MAP_TILES_DIR,
    cspOrigins: [...origins],
    client: {
      mode: parsed.VL_MAP_MODE,
      styleUrl: parsed.VL_MAP_STYLE_URL,
      pmtilesUrl: parsed.VL_MAP_PMTILES_URL,
      assetsUrl: parsed.VL_MAP_ASSETS_URL,
      attribution: parsed.VL_MAP_ATTRIBUTION,
    },
  };
}
