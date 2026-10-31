// Canonical theme ids shared by the API (validation) and the SPA (picker).
// `system` resolves on the client via prefers-color-scheme and is not stored
// as a rendered theme.
export const THEME_IDS = [
  'voltlink-dark',
  'voltlink-light',
  'fleet-ops',
  'high-contrast',
  'colorblind-safe',
  'system',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const THEME_ID_SET: ReadonlySet<string> = new Set(THEME_IDS);
