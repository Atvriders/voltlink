// a11y.spec.ts — accessibility scan on every core page in all five themes
// (guide 08 §12, tag @a11y). PL-05: the documented tags (including wcag21a /
// wcag21aa / wcag22aa) with color-contrast ENABLED — violations are expected
// reds until the R6 fixes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

const THEMES = [
  'voltlink-dark',
  'voltlink-light',
  'fleet-ops',
  'high-contrast',
  'colorblind-safe',
] as const;

const PAGES = [
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

test('PL-05: every core page in all five themes has no axe violations', async ({ page }) => {
  test.slow();
  const email = `e2e-a11y-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  for (const theme of THEMES) {
    await page.evaluate((id) => {
      document.documentElement.setAttribute('data-theme', id);
      localStorage.setItem('voltlink-theme', id);
    }, theme);
    for (const route of PAGES) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .exclude('[data-testid="vehicle-viewer"] canvas')
        .analyze();
      expect(
        results.violations.map((v) => `${v.id} ×${v.nodes.length}`),
        `${theme} ${route}: ${JSON.stringify(results.violations.map((v) => v.id))}`,
      ).toEqual([]);
    }
  }
});
