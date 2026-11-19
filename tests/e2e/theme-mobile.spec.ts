// R2-36 / TI-27: below 1024 px the Theme menu is hidden, so the account menu
// must carry a theme control — and the phone header must not overflow.
import { test, expect } from '@playwright/test';
import { register } from './helpers';

test.describe('theme reachable on phones (R2-36/TI-27)', () => {
  test('changes the theme from the account menu at a phone viewport without overflowing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const email = `theme-mobile-${Date.now()}@example.test`;
    await register(page, email);

    await page.goto('/vehicles', { waitUntil: 'domcontentloaded' });
    const accountMenu = page.locator('button[aria-label="Account menu"]:visible');
    await accountMenu.waitFor({ state: 'visible', timeout: 15000 });
    await accountMenu.click();

    // The below-lg entry point carries Settings AND a theme control.
    const lightTheme = page.getByRole('menuitem', {
      name: /Theme: VoltLink Light/,
    });
    await expect(lightTheme).toBeVisible();
    await lightTheme.click();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('voltlink-light');
    expect(await page.evaluate(() => localStorage.getItem('voltlink-theme'))).toBe(
      'voltlink-light',
    );

    // Nothing overflows horizontally at the phone viewport.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
