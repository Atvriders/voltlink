// FM-11: the legacy domain's route list renders the SPA NotFound page —
// no old radio page is accessible (L2182-2205, foundation migration acceptance).
// Runs against the dev/e2e stack; needs no demo mode.
import { test, expect } from '@playwright/test';
import { register } from './helpers';

const LEGACY_ROUTES = [
  '/checkin',
  '/nets',
  '/roster',
  '/callsigns',
  '/repeaters',
  '/netlogger',
  '/callbook',
  '/ham',
];

test.describe('legacy routes are gone', () => {
  for (const path of LEGACY_ROUTES) {
    test(`${path} renders the NotFound page`, async ({ page }) => {
      // Unknown routes render NotFound for signed-in users; anonymous
      // visitors are redirected to the sign-in page first.
      await register(page, `e2e-legacy-${Date.now()}-${path.slice(1)}@voltlink.test`);
      await page.goto(path);
      await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
    });
  }
});
