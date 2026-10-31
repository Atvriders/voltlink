// Visual regression: key pages snapshotted on desktop and mobile.
// Snapshots live next to this file; regenerate with --update-snapshots.

import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

const T = { maxDiffPixelRatio: 0.04 };

test('sign-in page', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'VoltLink' })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('signin.png', T);
});

test('overview desktop with demo fleet', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('overview.png', T);
});

test('live vehicle controls panel', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Live vehicle' }).first().click();
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('live-vehicle.png', T);
});

test('drives page', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/drives');
  await expect(page.getByRole('heading', { name: 'Drives' })).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('drives.png', T);
});

test('charging page', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/charging');
  await expect(page.getByText('Electricity rates')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('charging.png', T);
});

test('automations page', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/automations');
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('automations.png', T);
});

test('fleet page', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/fleet');
  await expect(page.getByText('Fleet status')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('fleet.png', T);
});

test('public status page', async ({ page }) => {
  await page.goto('/status');
  await expect(page.getByText(/operational|degraded|outage|maintenance/i).first()).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('public-status.png', T);
});

test('settings security tab', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await expect(page).toHaveScreenshot('settings.png', T);
});

test('admin page', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await page.goto('/admin');
  await expect(page.getByText(/Command safety|Platform health|Users/i).first()).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(1200);
  await expect(page).toHaveScreenshot('admin.png', T);
});

test('map page', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/map');
  await expect(page.locator('div[aria-label="Map"]')).toBeVisible({ timeout: 25000 });
  await page.waitForTimeout(3000);
  await expect(page).toHaveScreenshot('map.png', { maxDiffPixelRatio: 0.08 });
});

test('light theme overview', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });
  // switch to light theme via the theme menu
  await page.locator('[aria-label="Theme"]').click();
  await page.getByRole('menuitem', { name: /Light/i }).click();
  await page.waitForTimeout(1200);
  await expect(page).toHaveScreenshot('overview-light.png', T);
});

test('mobile overview', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1200);
  await expect(page).toHaveScreenshot('overview-mobile.png', T);
});
