// R2-07 / TI-36: real TOTP enrolment through the UI, then a recovery-code
// sign-in against the live MFA step.
import { test, expect } from '@playwright/test';
import otplib from 'otplib';

const { authenticator } = otplib;
import { register } from './helpers';

test.describe('TOTP enrolment and MFA sign-in (R2-07/TI-36)', () => {
  test('enrols TOTP and signs back in with a recovery code', async ({ page }) => {
    const email = `totp-${Date.now()}@example.test`;
    await register(page, email);

    // Enrol.
    await page.goto('/settings/security', { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('button', { name: /Set up TOTP/ })
      .first()
      .click();
    await page.getByRole('button', { name: /Generate secret/ }).click();
    await expect(page.getByText(/Scan this key/)).toBeVisible({ timeout: 15000 });
    const secret = (
      await page
        .locator('code')
        .filter({ hasText: /^[A-Z2-7]{16,}$/ })
        .first()
        .textContent()
    )?.trim();
    expect(secret).toBeTruthy();
    const code = authenticator.generate(secret!);
    await page.getByLabel('Verification code').fill(code);
    await page.getByRole('button', { name: /Verify & enable/ }).click();
    await expect(page.getByText('TOTP enabled!')).toBeVisible();

    const recovery = (await page.locator('li code').allTextContents()).map((r) => r.trim());
    expect(recovery.length).toBeGreaterThanOrEqual(1);

    // Sign out, then sign in again: the MFA step appears and accepts the
    // recovery code.
    await page.getByRole('button', { name: 'Account menu' }).first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(/login/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('e2e-password-123');
    await page
      .getByRole('button', { name: /^Sign in$/i })
      .first()
      .click();
    await expect(page.getByPlaceholder('6-digit code')).toBeVisible();
    await page.getByRole('checkbox', { name: /Use a recovery code/ }).check();
    await page.getByPlaceholder('Recovery code').fill(recovery[0]!);
    await page.getByRole('button', { name: /Verify/ }).click();
    await expect(page).toHaveURL(/vehicles/);
  });
});
