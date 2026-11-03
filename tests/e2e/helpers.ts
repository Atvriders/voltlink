// Shared E2E helpers: register a fresh user and enable demo mode.

import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';

/** Open registration answers 202 "check_email"; in the e2e environment the
 * dev token echo lands in the API log, so verify + sign in programmatically. */
async function devVerificationToken(): Promise<string> {
  const log = fs.readFileSync('/tmp/voltlink-api.log', 'utf8');
  const matches = [...log.matchAll(/\[mail:dev\] token echoed \(dev only\): (\S+)/g)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error('no dev verification token in /tmp/voltlink-api.log');
  return last[1]!;
}

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
  const regRes = await postDone;
  if (regRes.status() === 202) {
    // check_email: verify with the dev token, then sign in to get a session.
    const csrfRes = await page.request.get('/api/v1/auth/csrf');
    const csrf = ((await csrfRes.json()) as { data: { token: string } }).data.token;
    const token = await devVerificationToken();
    await page.request.post('/api/v1/auth/verify-email', {
      data: { token },
      headers: { 'x-vl-csrf': csrf },
    });
    const loginRes = await page.request.post('/api/v1/auth/login', {
      data: { email, password: 'e2e-password-123' },
      headers: { 'x-vl-csrf': csrf },
    });
    if (!loginRes.ok()) throw new Error(`login after verify failed: ${loginRes.status()}`);
  } else {
    await meOk;
  }
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
  const demoBtn = page.getByRole('button', { name: /Enable demo mode|Refresh demo fleet/ }).first();
  // The button only appears once the accounts query resolves; give it a beat
  // instead of skipping demo mode when the page is still loading.
  await demoBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
  if (await demoBtn.count()) {
    await demoBtn.click();
    await expect(page.getByText(/demo vehicles/)).toBeVisible({ timeout: 90000 });
  }
}
