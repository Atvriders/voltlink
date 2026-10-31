// C-NAMING regression test: legacy stored theme ids are normalized to the
// VoltLink ids, and every known id is preserved.

import { describe, expect, it } from 'vitest';
import { normalizeThemeId, THEMES } from './themes';

describe('theme id normalization', () => {
  it('keeps every known rendered theme id', () => {
    for (const t of THEMES) {
      if (t.id === 'system') continue; // resolved via prefers-color-scheme
      expect(normalizeThemeId(t.id)).toBe(t.id);
    }
  });

  it('maps legacy dark ids to voltlink-dark', () => {
    expect(normalizeThemeId('voltlank-dark')).toBe('voltlink-dark');
    expect(normalizeThemeId('unknown')).toBe('voltlink-dark');
    expect(normalizeThemeId('something-else')).toBe('voltlink-dark');
  });

  it('maps legacy light ids to voltlink-light', () => {
    expect(normalizeThemeId('voltlank-light')).toBe('voltlink-light');
    expect(normalizeThemeId('custom-light')).toBe('voltlink-light');
  });

  it('handles missing and empty values', () => {
    expect(normalizeThemeId(null)).toBe('voltlink-dark');
    expect(normalizeThemeId(undefined)).toBe('voltlink-dark');
    expect(normalizeThemeId('')).toBe('voltlink-dark');
  });
});
