// a11y-phone.spec.ts — PL-05 at phone width (web-6): every signed-in page
// under the real Pixel 7 project, all five themes. The desktop scan is
// a11y.spec.ts.
import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';
import { applyTheme, CORE_PAGES, EXTRA_PAGES, scan, THEMES } from './a11y-helpers';

test('PL-05 phone width: every signed-in page in all five themes', async ({ page }) => {
  test.setTimeout(900_000);
  test.slow();
  const email = `e2e-a11y-phone-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  const vehicles = await page.request.get('/api/v1/vehicles');
  const vbody = (await vehicles.json()) as { data?: { id: string }[] };
  const vid = vbody.data?.[0]?.id ?? '';
  expect(vid, 'demo fleet must exist').toBeTruthy();

  for (const theme of THEMES) {
    await applyTheme(page, theme);
    for (const route of CORE_PAGES) {
      const found = await scan(page, route, `phone ${theme}`);
      expect(found).toEqual([]);
    }
    for (const route of EXTRA_PAGES) {
      const found = await scan(page, route, `phone ${theme}`);
      expect(found).toEqual([]);
    }
    const live = await scan(page, `/vehicles/${vid}`, `phone ${theme}`);
    expect(live).toEqual([]);
  }
});
