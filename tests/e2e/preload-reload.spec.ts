// R2-37 / TI-28: a failing chunk may reload the page AT MOST ONCE per
// session; afterwards the route error card shows with the Shell still mounted.
import { test, expect, type Page } from '@playwright/test';
import { register } from './helpers';

async function loginFresh(page: Page): Promise<string> {
  const email = `preload-${Date.now()}@example.test`;
  await register(page, email);
  await page.goto('/vehicles', { waitUntil: 'domcontentloaded' });
  await page
    .locator('button[aria-label^="Account menu"]:visible')
    .waitFor({ state: 'visible', timeout: 15000 });
  return email;
}

test.describe('preload reload guard (R2-37/TI-28)', () => {
  test('a vite:preloadError reloads exactly once per session, then stays quiet (TI-28)', async ({
    page,
  }) => {
    // Count /vehicles document loads: the initial load plus the guard's reload.
    let vehiclesLoads = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url().includes('/vehicles')) vehiclesLoads += 1;
    });
    await loginFresh(page);
    // The real guard listens for the production vite:preloadError event.
    await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')));
    await expect.poll(() => vehiclesLoads, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    // Let the reloaded page finish mounting before the second failure.
    await page
      .locator('button[aria-label^="Account menu"]:visible')
      .waitFor({ state: 'visible', timeout: 15000 });
    // The session marker survives the reload: a second failure never reloads
    // again, however long the session lasts.
    const baseline = vehiclesLoads;
    await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')));
    await page.waitForTimeout(2000);
    // The second failure never navigates again (at most one reload per session).
    expect(vehiclesLoads).toBe(baseline);
    await page
      .locator('button[aria-label^="Account menu"]:visible')
      .waitFor({ state: 'visible', timeout: 15000 });
  });

  test('a route whose lazy chunk fails keeps the Shell mounted and never loops (TI-28)', async ({
    page,
  }) => {
    await loginFresh(page);
    // Abort ONLY the first chunk request (the route chunk): the failure must
    // land on the route error card or, after at most one guarded reload, on
    // the rendered page — never in a reload loop.
    let aborted = 0;
    await page.route('**/assets/**/*.js', (route) => {
      aborted += 1;
      if (aborted === 1) return route.abort();
      return route.continue();
    });
    const drivesLink = page.locator('a[href="/drives"]:visible');
    if (!(await drivesLink.count())) {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page
        .getByRole('link', { name: /Drives/ })
        .first()
        .waitFor({ state: 'visible' });
    }
    await drivesLink.first().click();
    await expect.poll(() => aborted, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    // The Shell stays mounted and the page reports the failure or renders.
    await page
      .locator('button[aria-label^="Account menu"]:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 });
    await expect(
      page.getByRole('heading', { name: /Drives|This page hit an error/ }).first(),
    ).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);
    await expect(page.locator('button[aria-label^="Account menu"]:visible').first()).toBeVisible();
  });
});
