// Theme ids for the VoltLink themes, imported from the shared package so the
// API validates against the same list. `system` resolves via
// prefers-color-scheme in AuthContext and is never stored as a rendered id.

import { THEME_ID_SET } from '@voltlink/shared';

export const THEMES = [
  { id: 'voltlink-dark', name: 'VoltLink Dark' },
  { id: 'voltlink-light', name: 'VoltLink Light' },
  { id: 'fleet-ops', name: 'Fleet Operations' },
  { id: 'high-contrast', name: 'High Contrast' },
  { id: 'colorblind-safe', name: 'Colorblind Safe' },
  { id: 'system', name: 'System' },
] as const;

export { THEME_ID_SET };

export type ThemeId = (typeof THEMES)[number]['id'];

/**
 * Normalize a stored theme id. Existing users may still have legacy ids in
 * localStorage or in the database (the migration fixes the database); the rule
 * maps any unknown id ending in `-light` to the light theme and anything else
 * to the dark theme, so existing users keep their choice.
 */
export function normalizeThemeId(id: string | null | undefined): ThemeId {
  if (id && THEME_ID_SET.has(id) && id !== 'system') return id as ThemeId;
  return id?.endsWith('-light') ? 'voltlink-light' : 'voltlink-dark';
}
