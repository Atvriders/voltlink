// no-webgl.spec.ts — with WebGL disabled the viewer must degrade to the
// procedural fallback silhouette (or render when the browser still exposes a
// software context), never crash or blank the page (guide 06 §12 / G-14).

import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

test('showroom survives without WebGL and never blanks', async ({ page }) => {
  const email = `e2e-nogl-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/showroom');
  await page.waitForURL(/showroom/);

  // The showroom auto-selects the first demo vehicle; the picker click is
  // optional (the list re-renders while telemetry refreshes, so clicking is
  // avoided — the assertion below is about the viewer, not the picker).
  const viewer = page.locator('[data-testid="vehicle-viewer"]');
  await expect(viewer).toBeVisible({ timeout: 30000 });
  const asset = await viewer.getAttribute('data-asset');
  expect(['glb', 'fallback']).toContain(asset);
  expect(errors.filter((e) => !/WebGL|three/i.test(e))).toEqual([]);
});
