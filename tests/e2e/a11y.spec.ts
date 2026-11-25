// a11y.spec.ts — accessibility scan on every page in all five themes
// (guide 08 §12, tag @a11y). PL-05: the documented tags (including wcag21a /
// wcag21aa / wcag22aa) with color-contrast ENABLED. web-6 added the missing
// routes: the public auth pages, onboarding, every settings tab, a live
// vehicle id, a drive id, the automations editor open, /admin as the instance
// admin and /status-admin; the phone-width run is a11y-phone.spec.ts.
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { enableDemo, register } from './helpers';
import { applyTheme, CORE_PAGES, EXTRA_PAGES, PUBLIC_PAGES, scan, THEMES } from './a11y-helpers';

const TIMEOUT = 900_000;

test('PL-05 public auth pages: login, register, setup', async ({ page }) => {
  test.setTimeout(TIMEOUT);
  test.slow();
  // /setup on a bootstrapped instance redirects to /login; both renderings
  // are real pages to scan.
  for (const route of PUBLIC_PAGES) {
    const found = await scan(page, route, 'public');
    expect(found).toEqual([]);
  }
});

test('PL-05 signed-in pages in all five themes', async ({ page }) => {
  test.setTimeout(TIMEOUT);
  test.slow();
  const email = `e2e-a11y-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  // Dynamic routes: the first demo vehicle and the first drive.
  const vehicles = await page.request.get('/api/v1/vehicles');
  const vbody = (await vehicles.json()) as { data?: { id: string }[] };
  const vid = vbody.data?.[0]?.id ?? '';
  expect(vid, 'demo fleet must exist').toBeTruthy();
  await page.goto('/drives');
  const driveLink = page.getByRole('link').first();
  await expect(driveLink).toBeVisible({ timeout: 30000 });
  const driveHref = (await driveLink.getAttribute('href')) ?? '';
  expect(driveHref, 'drive detail link').toBeTruthy();

  for (const theme of THEMES) {
    await applyTheme(page, theme);
    for (const route of CORE_PAGES) {
      const found = await scan(page, route, theme);
      expect(found).toEqual([]);
    }
    for (const route of EXTRA_PAGES) {
      const found = await scan(page, route, theme);
      expect(found).toEqual([]);
    }
    const live = await scan(page, `/vehicles/${vid}`, theme);
    expect(live).toEqual([]);
    const drive = await scan(page, driveHref, theme);
    expect(drive).toEqual([]);
  }

  // Automations editor open (modal) — every theme.
  for (const theme of THEMES) {
    await applyTheme(page, theme);
    await page.goto('/automations');
    await page.getByRole('button', { name: 'New automation' }).click();
    await expect(page.getByText('Trigger')).toBeVisible({ timeout: 20000 });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .exclude('[data-testid="vehicle-viewer"] canvas')
      .analyze();
    expect(
      results.violations.map((v) => `${v.id} ×${v.nodes.length}`),
      `automations editor ${theme}`,
    ).toEqual([]);
  }
});

test('PL-05 admin pages as the instance admin: /admin and /status-admin', async ({ page }) => {
  test.setTimeout(TIMEOUT);
  test.slow();
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.E2E_ADMIN_EMAIL ?? 'admin@voltlink-e2e.test');
  await page
    .getByLabel('Password')
    .fill(process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: /Account menu/ })).toBeVisible({
    timeout: 20000,
  });
  for (const theme of THEMES) {
    await applyTheme(page, theme);
    for (const route of ['/admin', '/status-admin']) {
      const found = await scan(page, route, `admin ${theme}`);
      expect(found).toEqual([]);
    }
  }
});
