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
      .toContain(`/assets/models/${cls}`);
    await expect(viewer.first()).toHaveAttribute('data-asset', 'glb', {
      timeout: 30000,
    });
    console.log(`glb asset ${cls} rendered for ${name}`);
  }
  expect(errors, 'no page errors during the whole sweep').toEqual([]);
});
