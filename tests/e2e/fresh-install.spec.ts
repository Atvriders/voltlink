// R3 fresh-install browser test: the install docs' first-run path driven
// entirely through the web UI — /setup with the setup token, no API or SQL
// shortcuts. Runs against a stack booted by start-stack.sh with
// VL_FRESH_SETUP=1.

import { test, expect } from '@playwright/test';

test('a fresh install is set up through the web UI', async ({ page }) => {
  const token = process.env.FRESH_SETUP_TOKEN;
  test.skip(!token, 'FRESH_SETUP_TOKEN not provided (start-stack fresh mode)');

  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Welcome to VoltLink' })).toBeVisible();

  const stamp = Date.now();
  await page.getByLabel('Your name').fill('Fresh Admin');
  await page.getByLabel('Email').fill(`fresh-${stamp}@voltlink-e2e.test`);
  await page.getByLabel('Password (min 10 characters)').fill('fresh-admin-password-123');
  await page.getByLabel('Setup token').fill(token!);
  await page.getByRole('button', { name: 'Create administrator' }).click();

  // Registration succeeds and lands in the app.
  await expect(page).toHaveURL(/\/overview/, { timeout: 30_000 });
  await expect(page.getByText('Fresh Admin', { exact: false }).first()).toBeVisible();
});
