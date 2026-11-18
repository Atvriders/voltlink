// R2-37 / TI-28: a failing lazy chunk may reload the page AT MOST ONCE per
// session; afterwards the route error card shows with the Shell still mounted.
import { test, expect, type Page } from '@playwright/test';
import { register } from './helpers';

async function loginFresh(page: Page): Promise<string> {
  const email = `preload-${Date.now()}@example.test`;
  await register(page, email);
  await page.goto('/vehicles', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: 'Account menu' })
    .first()
    .waitFor({ state: 'visible', timeout: 15000 });
  return email;
}

test.describe('preload reload guard (R2-37/TI-28)', () => {
  test('aborted lazy chunk reloads once, then the error card shows with the Shell mounted', async ({
    page,
  }) => {
    await loginFresh(page);
    let profileLoads = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url().includes('/settings/profile'))
        profileLoads += 1;
    });
    // Kill every lazy chunk: the first load fails, the guarded reload fails
    // again, and the second failure must land on the error card — no loop.
    await page.route('**/assets/**/*.js', (route) => route.abort());
    await page.goto('/settings/profile', { waitUntil: 'domcontentloaded' });

    // Exactly one guarded reload beyond the initial navigation.
    await expect.poll(() => profileLoads).toBe(2);
    // The Shell survives: the account menu and the header are still there.
    await page
      .getByRole('button', { name: 'Account menu' })
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    // And the error card, not another reload, reports the failure.
    await expect(page.getByText('This page hit an error')).toBeVisible();
    // Give any erroneous extra reload a moment to surface, then prove the
    // count stayed at one reload.
    await page.waitForTimeout(2000);
    expect(profileLoads).toBe(2);
  });

  test('chunk failing only on the first attempt reloads once and then renders', async ({
    page,
  }) => {
    await loginFresh(page);
    let profileLoads = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url().includes('/settings/profile'))
        profileLoads += 1;
    });
    let attempts = 0;
    // Fail the first request for the lazy chunk only; the reload succeeds.
    await page.route('**/assets/**/*.js', (route) => {
      attempts += 1;
      if (attempts === 1) return route.abort();
      return route.continue();
    });
    await page.goto('/settings/profile', { waitUntil: 'domcontentloaded' });

    await expect.poll(() => profileLoads).toBe(2);
    await page
      .getByRole('button', { name: 'Account menu' })
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    // The profile page content renders after the single reload.
    await expect(page.getByText(/profile/i).first()).toBeVisible();
    await page.waitForTimeout(2000);
    expect(profileLoads).toBe(2);
  });
});
