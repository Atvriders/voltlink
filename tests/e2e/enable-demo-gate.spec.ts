// R2-16 / C-E2EHOLLOW gate (also TI-11): enableDemo must not return before
// the demo connect POST completes. The old helper waited on static page text
// ('All demo vehicles are fictional…'), which is present before any vehicle
// exists — the verifier's held-connect probe proved it returns with 0 vehicles.
// This spec holds the connect response for 2000 ms; a correct helper must wait
// for it (elapsed >= 1500 ms), the old one returns at once (elapsed < 1500 ms).
import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

test('R2-16/C-E2EHOLLOW/TI-11: enableDemo waits for the demo connect response', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await register(page, `gate-${Date.now()}@voltlink-e2e.test`);
  await page.route('**/providers/demo/connect', async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  const t0 = Date.now();
  await enableDemo(page);
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeGreaterThanOrEqual(1500);
});
