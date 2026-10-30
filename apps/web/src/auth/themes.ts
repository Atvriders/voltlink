// Theme ids for the VoltLink themes. Kept in a small dependency-free module so
// tests can import the list and the normalization rule without React.

export const THEMES = [
  { id: 'voltlink-dark', name: 'VoltLink Dark' },
  { id: 'voltlink-light', name: 'VoltLink Light' },
  { id: 'fleet-ops', name: 'Fleet Operations' },
  { id: 'high-contrast', name: 'High Contrast' },
  { id: 'colorblind-safe', name: 'Colorblind Safe' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

const THEME_IDS = new Set<string>(THEMES.map((t) => t.id));

/**
 * Normalize a stored theme id. Existing users may still have legacy ids in
 * localStorage or in the database (the migration fixes the database); the rule
 * maps any unknown id ending in `-light` to the light theme and anything else
 * to the dark theme, so existing users keep their choice.
 */
export function normalizeThemeId(id: string | null | undefined): ThemeId {
  if (id && THEME_IDS.has(id)) return id as ThemeId;
  return id?.endsWith('-light') ? 'voltlink-light' : 'voltlink-dark';
}
