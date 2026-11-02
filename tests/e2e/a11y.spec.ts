// a11y.spec.ts — accessibility scan on the core pages (guide 08 §12, tag @a11y).
// wcag2a/wcag2aa, excluding contrast (visual suite covers color contrast).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

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
  '/settings',
] as const;

test('core pages have no serious a11y violations', async ({ page }) => {
  test.slow();
  const email = `e2e-a11y-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  for (const route of PAGES) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious, `${route}: ${JSON.stringify(serious.map((v) => v.id))}`).toEqual([]);
  }
});
