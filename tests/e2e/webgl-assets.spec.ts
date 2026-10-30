// WebGL asset integration: the showroom must load the Blender-generated GLBs
// (data-asset="glb"), not the procedural fallback, for every vehicle class.

import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

test('showroom renders GLB assets for all demo vehicle classes', async ({ page }) => {
  const email = `e2e-glb-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  await page.goto('/showroom');
  await page.waitForURL(/showroom/);

  // The five demo vehicles; each picker button renders the viewer and the
  // GLB loads asynchronously (procedural fallback shows first).
  const demoVehicles = ['Aurora', 'Comet', 'Terra', 'Atlas', 'Bison'];
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });

  for (const name of demoVehicles) {
    await page.getByRole('button', { name: new RegExp(name) }).first().click();
    await expect(page.locator('[data-testid="vehicle-viewer"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-testid="vehicle-viewer"][data-asset="glb"]')).toBeVisible({ timeout: 30000 });
    console.log(`glb asset rendered for ${name}`);
  }
});
