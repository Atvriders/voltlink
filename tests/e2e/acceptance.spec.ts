// End-to-end acceptance test: registration → demo mode → vehicles → command
// lifecycle → key pages render without console errors.

import { expect, test } from '@playwright/test';
import { register } from './helpers';

const consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location().url;
    // Benign: unauthenticated /auth/me on first load and missing favicon.
    if (msg.text().includes('401') && url.includes('/api/v1/auth/me')) return;
    if (msg.text().includes('status of 404') && !url.includes('/api/')) return;
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
});


test('full demo acceptance flow', async ({ page }) => {
  const email = `e2e-${Date.now()}@voltlink.test`;
  await register(page, email);

  // Enable demo mode via providers page if not already
  await page.goto('/providers');
  await page.waitForURL(/providers/);
  const demoBtn = page.getByRole('button', { name: /Enable demo mode|Refresh demo fleet/ });
  if (await demoBtn.count()) {
    await demoBtn.click();
    await expect(page.getByText(/demo vehicles/)).toBeVisible({ timeout: 30000 });
  }

  // Vehicles visible in overview
  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });

  // Open a live vehicle page via the overview card action
  await page.getByRole('button', { name: 'Live vehicle' }).first().click();
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Battery & charging')).toBeVisible();

  // Issue a safe command and watch the lifecycle
  await page.getByRole('button', { name: /^Honk horn/ }).click();
  await expect(page.getByText('Queued').first()).toBeVisible({ timeout: 15000 });

  // Showroom renders the 3D viewer
  await page.goto('/showroom');
  await expect(page.locator('[data-testid="vehicle-viewer"]')).toBeVisible({ timeout: 20000 });

  // Drives, charging, battery, fleet
  await page.goto('/drives');
  await expect(page.getByRole('heading', { name: 'Drives' })).toBeVisible();
  await expect(page.locator('text=km').first()).toBeVisible({ timeout: 15000 });
  await page.goto('/charging');
  await expect(page.getByText('Electricity rates')).toBeVisible({ timeout: 15000 });
  await page.goto('/battery');
  await expect(page.getByText('Battery health estimate')).toBeVisible({ timeout: 15000 });
  await page.goto('/fleet');
  await expect(page.getByText('Fleet status')).toBeVisible({ timeout: 15000 });
  await page.goto('/map');
  await expect(page.locator('div[aria-label="Map"]')).toBeVisible({ timeout: 20000 });

  // Public status page
  await page.goto('/status');
  await expect(page.getByText(/operational|degraded|outage|maintenance/i).first()).toBeVisible({ timeout: 15000 });

  // Notifications & settings
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toHaveLength(0);
});

test('mobile layout renders', async ({ page }) => {
  const email = `e2e-m-${Date.now()}@voltlink.test`;
  await register(page, email);
  await page.goto('/providers');
  await page.waitForURL(/providers/);
  const demoBtn = page.getByRole('button', { name: /Enable demo mode|Refresh demo fleet/ });
  if (await demoBtn.count()) {
    await demoBtn.click();
    await expect(page.getByText(/demo vehicles/)).toBeVisible({ timeout: 30000 });
  }
  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Live vehicle' }).first().click();
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toHaveLength(0);
});

test('onboarding walks through all steps', async ({ page }) => {
  const email = `e2e-onb-${Date.now()}@voltlink.test`;
  await register(page, email);
  await page.goto('/onboarding');
  await page.waitForURL(/onboarding/);
  await expect(page.getByText('Welcome to VoltLink')).toBeVisible({ timeout: 15000 });
  // Walk every step; the badge confirms each advance (some steps run mutations).
  for (let i = 0; i < 11; i++) {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText(new RegExp(`step ${i + 2} of 12`))).toBeVisible({ timeout: 15000 });
  }
  await expect(page.getByText('You’re all set').first()).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Open VoltLink' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toHaveLength(0);
});
