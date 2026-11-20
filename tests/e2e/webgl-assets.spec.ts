// WebGL asset integration: the showroom must load the Blender-generated GLBs
// (data-asset="glb"), not the procedural fallback, for every vehicle class.

import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

const CLASS_BY_NAME: Record<string, string> = {
  Aurora: 'compact_sedan',
  Comet: 'sport_sedan',
  Terra: 'compact_crossover',
  Atlas: 'suv',
  Bison: 'pickup',
};

test('showroom renders the right GLB per vehicle class, with zero page errors', async ({
  page,
}) => {
  // Five GLB loads plus the WEBGL_lose_context cycle take ~1.1m on the shared
  // machine's SwiftShader path; the default 60s test timeout is too tight
  // (PROGRESS honesty 2026-11-20, review #2 point 10). Assertion timeouts
  // inside the test are unchanged.
  test.setTimeout(180_000);
  const email = `e2e-glb-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/showroom');
  await page.waitForURL(/showroom/);

  // The five demo vehicles; each picker button renders the viewer and the
  // GLB loads asynchronously (procedural fallback shows first).
  const demoVehicles = ['Aurora', 'Comet', 'Terra', 'Atlas', 'Bison'];
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });

  for (const name of demoVehicles) {
    const cls = CLASS_BY_NAME[name];
    expect(cls, `class known for ${name}`).toBeTruthy();
    await page
      .getByRole('button', { name: new RegExp(name) })
      .first()
      .click();
    const viewer = page.locator('[data-testid="vehicle-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 20000 });
    // C-WEBGLTEST: the loaded asset is the REAL GLB and its URL is the one
    // for THIS class (the old suite passed with any other class's GLB, even
    // while the requested asset was held unanswered).
    await expect
      .poll(async () => viewer.first().getAttribute('data-asset-url'), {
        timeout: 30000,
      })
      .toContain(`${cls}.`);
    await expect(viewer.first()).toHaveAttribute('data-asset', 'glb', {
      timeout: 30000,
    });
    // C-WEBGLTEST: part names — the loaded GLB must expose the required
    // part set (guide 06 s12); a wrong or truncated model fails here.
    const parts = (await viewer.first().getAttribute('data-parts')) ?? '';
    for (const p of ['body_mesh', 'wheel_fl', 'wheel_fr', 'door_fl']) {
      expect(parts, `${cls} GLB must contain part ${p}`).toContain(p);
    }
    console.log(`glb asset ${cls} rendered for ${name}`);
  }

  // Context loss (guide 06 s12 / guide 08 s12): lose the context, restore it,
  // and the viewer must keep rendering without a page error.
  const lose = await page.evaluate(() => {
    const c = document.querySelector(
      '[data-testid="vehicle-viewer"] canvas',
    ) as HTMLCanvasElement | null;
    const gl = (c?.getContext('webgl2') || c?.getContext('webgl')) as WebGLRenderingContext | null;
    const ext = gl?.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    return Boolean(ext);
  });
  expect(lose, 'WEBGL_lose_context available').toBe(true);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const c = document.querySelector(
      '[data-testid="vehicle-viewer"] canvas',
    ) as HTMLCanvasElement | null;
    const gl = (c?.getContext('webgl2') || c?.getContext('webgl')) as WebGLRenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.restoreContext();
  });
  await page.waitForTimeout(500);
  await expect(page.locator('[data-testid="vehicle-viewer"]').first()).toHaveAttribute(
    'data-asset',
    'glb',
    { timeout: 10000 },
  );
  expect(errors, 'no page errors during the whole sweep').toEqual([]);
});
