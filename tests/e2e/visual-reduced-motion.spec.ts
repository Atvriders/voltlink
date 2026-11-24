// Guide 08 §11 state #21: reduced motion — the reduced-motion project renders
// the vehicle page with no running animations and stable frames for a second.
import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

const FROZEN = new Date('2026-06-15T15:30:00Z');

test('reduced motion stops animations on the live vehicle page', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN);
  await register(page, `e2e-vis-rm-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  const vehicles = await page.request.get('/api/v1/vehicles');
  const body = (await vehicles.json()) as {
    data?: { id: string; displayName?: string }[];
  };
  const aurora = (body.data ?? []).find((v) => (v.displayName ?? '').includes('Aurora'));
  await page.goto(`/vehicles/${aurora!.id}`);
  await expect(page.locator('[data-testid="vehicle-viewer"]').first()).toBeVisible({
    timeout: 30000,
  });
  // Guide 08 §11.4: with reduced motion no Web/CSS animation may run.
  await expect
    .poll(async () => page.evaluate(() => document.getAnimations().length), { timeout: 30000 })
    .toBe(0);
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('reduced-motion.png', {
    fullPage: true,
    mask: [
      page.locator('[data-relative-time]'),
      // the per-run account email renders in the sidebar
      page.getByRole('button', { name: /Account menu/ }),
    ],
    timeout: 60000,
  });
});
