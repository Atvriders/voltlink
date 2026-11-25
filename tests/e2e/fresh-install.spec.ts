// R3 fresh-install browser test: the install docs' first-run path driven
// entirely through the web UI — /setup with the setup token, no API or SQL
// shortcuts. Runs against a stack booted by start-stack.sh with
// VL_FRESH_SETUP=1 (which exports FRESH_SETUP_TOKEN).
//
// TI-12: no test.skip — CI always passes a token; a run without one fails
// loudly. The walk starts at '/' (a pending setup redirects there), and
// after setup the visitor lands on '/' with the admin's name and email in
// the shell.

import { test, expect } from '@playwright/test';

test('a fresh install is set up through the web UI', async ({ page }) => {
  const token = process.env.FRESH_SETUP_TOKEN;
  if (!token) {
    throw new Error(
      'FRESH_SETUP_TOKEN not provided (start-stack fresh mode) — CI must always pass it',
    );
  }

  // Start from the app root: while setup is pending the root redirects to
  // /setup (R2-01).
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to VoltLink' })).toBeVisible();

  // CI pins the credentials so the smoke can sign in with the same account
  // afterwards (login-reuse mode); local runs use a fresh timestamp.
  const email = process.env.FRESH_E2E_EMAIL ?? `fresh-${Date.now()}@voltlink-e2e.test`;
  const password = process.env.FRESH_E2E_PASSWORD ?? 'fresh-admin-password-123';
  await page.getByLabel('Your name').fill('Fresh Admin');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password (min 10 characters)').fill(password);
  await page.getByLabel('Setup token').fill(token);
  await page.getByRole('button', { name: 'Create administrator' }).click();

  // Registration succeeds and lands on '/' (R2-01), with the admin's email
  // in the shell's account button and inside the account menu (TI-12: the
  // admin's name or email must be visible; the shell displays the email).
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByText(email, { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: /Account menu/ }).click();
  await expect(page.getByRole('menu').getByText(email)).toBeVisible();
});
