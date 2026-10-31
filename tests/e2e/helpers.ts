// Shared E2E helpers: register a fresh user and enable demo mode.

import { expect, type Page } from '@playwright/test';

export async function register(page: Page, email: string): Promise<void> {
  const hydrated = page.waitForResponse((r) => r.url().includes('/api/v1/auth/me'));
  await page.goto('/register', { waitUntil: 'domcontentloaded' });
  // React mounts and AuthProvider issues /auth/me — only then are handlers attached.
  await hydrated;
  await page.getByLabel('Name').fill('E2E Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-123');
  const postDone = page.waitForResponse(
    (r) => r.url().includes('/auth/register') && r.request().method() === 'POST',
  );
  const meOk = page.waitForResponse((r) => r.url().includes('/api/v1/auth/me') && r.ok());
  await page.getByRole('button', { name: 'Create account' }).click();
  await postDone;
  await meOk;
  // Ensure the session cookie is committed before the test navigates on.
  await expect
    .poll(async () => (await page.context().cookies()).some((c) => c.name === 'vl_session'), {
      timeout: 10000,
    })
    .toBe(true);
}

export async function enableDemo(page: Page): Promise<void> {
  await page.goto('/providers');
  await page.waitForURL(/providers/);
  const demoBtn = page.getByRole('button', { name: /Enable demo mode|Refresh demo fleet/ });
  if (await demoBtn.count()) {
    await demoBtn.click();
    await expect(page.getByText(/demo vehicles/)).toBeVisible({ timeout: 30000 });
  }
}
