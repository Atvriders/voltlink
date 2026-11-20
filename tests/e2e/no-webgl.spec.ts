// no-webgl.spec.ts — with WebGL disabled the viewer must degrade to the
// procedural fallback silhouette (or render when the browser still exposes a
// software context), never crash or blank the page (guide 06 §12 / G-14).

import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

test('showroom degrades to the fallback marker without WebGL, with zero page errors', async ({
  page,
}) => {
  // Attach the pageerror listener FIRST so no error between register() and
  // the showroom visit can slip past (review #2 point 8).
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  const email = `e2e-nogl-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);
  // The demo fleet must actually exist before the showroom renders (a viewer
  // over an empty fleet proves nothing).
  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });

  await page.goto('/showroom');
  await page.waitForURL(/showroom/);

  const viewer = page.locator('[data-testid="vehicle-viewer"]');
  await expect(viewer).toBeVisible({ timeout: 30000 });
  // R2-63: under --disable-webgl the ONLY acceptable render is the labeled
  // procedural fallback marker — not 'glb', and not a silent blank. 'fallback'
  // also appears while the GLB loads WITH WebGL on, so the data-webgl hook
  // proves this is really the no-WebGL branch.
  await expect
    .poll(() => viewer.getAttribute('data-webgl'), { timeout: 30000 })
    .toBe('unsupported');
  await expect.poll(() => viewer.getAttribute('data-asset'), { timeout: 30000 }).toBe('fallback');
  // The no-WebGL path mounts no canvas at all.
  await expect(viewer.locator('canvas')).toHaveCount(0);
  // Any page error fails the test (the old filter dropped /WebGL|three/i).
  expect(errors).toEqual([]);
});
