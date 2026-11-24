// Guide 08 §11 state #8: WebGL fallback — the no-webgl project renders the
// vehicle page with data-webgl="unsupported" and the nav still works.
import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

const FROZEN = new Date('2026-06-15T15:30:00Z');

test('webgl fallback shows data-webgl=unsupported with the nav visible', async ({ page }) => {
  await page.clock.setFixedTime(FROZEN);
  await register(page, `e2e-vis-nogl-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  const vehicles = await page.request.get('/api/v1/vehicles');
  const body = (await vehicles.json()) as {
    data?: { id: string; displayName?: string }[];
  };
  const aurora = (body.data ?? []).find((v) => (v.displayName ?? '').includes('Aurora'));
  await page.goto(`/vehicles/${aurora!.id}`);
  const viewer = page.locator('[data-testid="vehicle-viewer"]').first();
  await expect(viewer).toBeVisible({ timeout: 30000 });
  await expect(viewer).toHaveAttribute('data-webgl', 'unsupported');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('webgl-fallback.png', {
    fullPage: true,
    mask: [
      page.locator('[data-relative-time]'),
      // the per-run account email renders in the sidebar
      page.getByRole('button', { name: /Account menu/ }),
    ],
    timeout: 60000,
  });
});
