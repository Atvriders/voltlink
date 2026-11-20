// Mobile and tablet visual snapshots, run under the REAL mobile (Pixel 7)
// and tablet (iPad Pro 11) Playwright projects — never a desktop render with
// a fake viewport (FE-26 / C-VISUAL). Project viewports apply; no
// setViewportSize overrides. Baselines regenerate in R6.

import { expect, test, type Page } from '@playwright/test';
import { DEMO_VEHICLES, enableDemo, register } from './helpers';

const T = { maxDiffPixels: 25 };

function maskDynamic(page: Page) {
  return [page.getByRole('button', { name: 'Account menu' }), page.locator('.tabular-nums')];
}

async function registerWithDemoFleet(page: Page): Promise<void> {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/');
  for (const name of DEMO_VEHICLES) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible({
      timeout: 30000,
    });
  }
}

test('overview at project viewport', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('overview.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('live vehicle controls at project viewport', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.getByRole('button', { name: 'Live vehicle' }).first().click();
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Aurora', { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('live-vehicle.png', {
    ...T,
    mask: maskDynamic(page),
  });
});
