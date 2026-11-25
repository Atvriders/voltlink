// a11y-helpers.ts — shared scan for the PL-05 specs (desktop + Pixel 7).
// Guide 08 §12: the documented tag set with color-contrast ON; the viewer
// canvas is the only exclusion (WebGL has no accessible tree).
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export const THEMES = [
  'voltlink-dark',
  'voltlink-light',
  'fleet-ops',
  'high-contrast',
  'colorblind-safe',
] as const;

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Core signed-in pages (the original 15).
export const CORE_PAGES = [
  '/',
  '/vehicles',
  '/showroom',
  '/map',
  '/drives',
  '/charging',
  '/battery',
  '/automations',
  '/fleet',
  '/providers',
  '/notifications',
  '/settings',
  '/settings/security',
  '/settings/sessions',
  '/status',
] as const;

// Routes the previous spec missed (web-6): every settings tab, onboarding and
// the two public auth pages that render without a session.
export const EXTRA_PAGES = ['/onboarding', '/settings/privacy'] as const;

export const PUBLIC_PAGES = ['/login', '/register', '/setup'] as const;

export async function scan(page: Page, route: string, context: string): Promise<string[]> {
  await page.goto(route);
  await page.waitForLoadState('networkidle');
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    .exclude('[data-testid="vehicle-viewer"] canvas')
    .analyze();
  const found = results.violations.map((v) => `${v.id} ×${v.nodes.length}`);
  if (found.length > 0) {
    throw new Error(
      `${context} ${route}: ${found.join(', ')} — ${JSON.stringify(
        results.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target.slice(0, 4)),
        })),
      )}`,
    );
  }
  return found;
}

export async function applyTheme(page: Page, theme: string): Promise<void> {
  await page.evaluate((id) => {
    document.documentElement.setAttribute('data-theme', id);
    localStorage.setItem('voltlink-theme', id);
  }, theme);
}
