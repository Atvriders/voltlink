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
  // R2-61: browser console errors count too — the old viewer fired a 404
  // HEAD for /assets/models/<class>.glb on every mount before the staged
  // manifest resolved, and Chromium logs it as a console.error.
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

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

  // C-WEBGLTEST keying proof (NEW-18): when the NEXT class's GLB is held
  // unanswered (HEAD fulfilled, GET aborted), a later vehicle must recover
  // to its own GLB. The viewer is keyed by vehicle id, so the failed load
  // never sticks to the following vehicles.
  await page.route('**/sport_sedan.glb', (route) => {
    if (route.request().method() === 'HEAD') route.fulfill({ status: 200, body: '' });
    else route.abort();
  });
  await page.getByRole('button', { name: /Comet/ }).first().click();
  await expect
    .poll(() => page.locator('[data-testid="vehicle-viewer"]').first().getAttribute('data-asset'), {
      timeout: 30000,
    })
    .toBe('fallback');
  await page.unroute('**/sport_sedan.glb');
  await page.getByRole('button', { name: /Terra/ }).first().click();
  await expect
    .poll(
      async () =>
        page.locator('[data-testid="vehicle-viewer"]').first().getAttribute('data-asset-url'),
      { timeout: 30000 },
    )
    .toContain('compact_crossover.');

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
  expect(
    consoleErrors.filter((t) => t.includes('404')),
    'no 404 console errors during the sweep (R2-61)',
  ).toEqual([]);
});

/** Quantized unique colours in the viewer canvas: a blank or failed render
 * has ~1; a real vehicle has dozens (R2-44 pixel assertion). */
/** Pick a vehicle by display name from the shell fleet switcher. On the
 * vehicle detail pages the fleet list lives behind the "Fleet N Choose
 * vehicle" / "Vehicle: X. Change vehicle" menu button, and its rows are
 * role="menuitem" buttons that only exist while the menu is open. */
async function switchVehicle(page: import('@playwright/test').Page, name: string) {
  const switcher = page.getByRole('button', { name: /Choose vehicle|Change vehicle/ }).first();
  if (await switcher.isVisible().catch(() => false)) {
    await switcher.click();
  }
  await page.getByRole('menuitem', { name: new RegExp(name) }).first().click();
}

async function uniqueColors(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector(
      '[data-testid="vehicle-viewer"] canvas',
    ) as HTMLCanvasElement | null;
    if (!c) return 0;
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 0;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const seen = new Set<number>();
    for (let i = 0; i < buf.length; i += 4) {
      const q = ((buf[i]! >> 4) << 8) | ((buf[i + 1]! >> 4) << 4) | (buf[i + 2]! >> 4);
      seen.add(q);
    }
    return seen.size;
  });
}

test('R2-44: per-class pixels, presets and GPU memory return to baseline', async ({ page }) => {
  test.setTimeout(240_000);
  const email = `e2e-glb44-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  const vehiclesRes = await page.request.get('/api/v1/vehicles');
  const vehicles =
    ((await vehiclesRes.json()) as { data?: { id: string; displayName?: string }[] }).data ?? [];
  expect(vehicles.length, 'demo fleet').toBeGreaterThanOrEqual(5);
  const first = vehicles[0]!;

  await page.goto(`/vehicles/${first.id}`);
  const viewer = page.locator('[data-testid="vehicle-viewer"]');
  await expect
    .poll(() => viewer.first().getAttribute('data-asset'), { timeout: 30000 })
    .toBe('glb');

  // Pixel assertion: every vehicle class renders non-background geometry.
  const demoVehicles = ['Aurora', 'Comet', 'Terra', 'Atlas', 'Bison'];
  for (const name of demoVehicles) {
    await switchVehicle(page, name);
    await expect
      .poll(() => viewer.first().getAttribute('data-asset'), { timeout: 30000 })
      .toBe('glb');
    // Poll rather than sleep: on the shared runner the first rendered frame
    // of a freshly-mounted model can take longer than any fixed wait, and
    // until it lands readPixels sees the cleared buffer (1 colour).
    await expect
      .poll(async () => uniqueColors(page), {
        timeout: 30000,
        message: `${name} renders real pixels`,
      })
      .toBeGreaterThan(50);
  }

  // Preset test: low → _lod2, medium → _lod, high/ultra → LOD0, and the
  // pixel ratio follows the preset (1 for low, >1.5 for high/ultra).
  // The suffix assertions are class-specific: return to Aurora (the first
  // demo vehicle, compact_sedan) so they hold regardless of where the
  // pixel sweep above stopped.
  await switchVehicle(page, 'Aurora');
  await expect
    .poll(() => viewer.first().getAttribute('data-asset'), { timeout: 30000 })
    .toBe('glb');
  const presetSelect = page.locator('select[aria-label="Graphics preset"]');
  const presetCases: [string, RegExp][] = [
    ['low', /_lod2\./],
    ['medium', /_lod\./],
    ['high', /compact_sedan\./],
    ['ultra', /compact_sedan\./],
  ];
  for (const [preset, suffix] of presetCases) {
    await presetSelect.selectOption(preset);
    await expect
      .poll(() => viewer.first().getAttribute('data-asset-url'), { timeout: 30000 })
      .toMatch(suffix);
    const dpr = await page.evaluate(() => {
      const c = document.querySelector(
        '[data-testid="vehicle-viewer"] canvas',
      ) as HTMLCanvasElement | null;
      if (!c) return 0;
      return c.width / Math.max(1, c.getBoundingClientRect().width);
    });
    if (preset === 'low') expect(dpr, 'low preset renders at 1x').toBeLessThan(1.2);
    if (preset === 'high' || preset === 'ultra') {
      expect(dpr, `${preset} preset renders above 1.5x`).toBeGreaterThan(1.5);
    }
  }

  // Memory test: geometries/textures must return to baseline after cycling
  // every vehicle — no per-switch GPU growth (R2-44).
  await presetSelect.selectOption('high');
  await expect
    .poll(() => viewer.first().getAttribute('data-asset'), { timeout: 30000 })
    .toBe('glb');
  const readMem = async () => ({
    geometries: Number(await viewer.first().getAttribute('data-gpu-geometries')),
    textures: Number(await viewer.first().getAttribute('data-gpu-textures')),
  });
  const baseline = await readMem();
  expect(baseline.geometries, 'baseline geometries recorded').toBeGreaterThan(0);
  for (const name of [...demoVehicles.slice(1), 'Aurora']) {
    await switchVehicle(page, name);
    await expect
      .poll(() => viewer.first().getAttribute('data-asset'), { timeout: 30000 })
      .toBe('glb');
  }
  const after = await readMem();
  expect(
    Math.abs(after.geometries - baseline.geometries),
    `geometries return to baseline (${baseline.geometries} -> ${after.geometries})`,
  ).toBeLessThanOrEqual(8);
  expect(
    Math.abs(after.textures - baseline.textures),
    `textures return to baseline (${baseline.textures} -> ${after.textures})`,
  ).toBeLessThanOrEqual(8);
});

test('R2-61: real GLBs load on /vehicles/<id> and /presentation with zero 404s', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = `e2e-glb61-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const vehiclesRes = await page.request.get('/api/v1/vehicles');
  const vehicles = ((await vehiclesRes.json()) as { data?: { id: string }[] }).data ?? [];
  const first = vehicles[0]!;
  await page.goto(`/vehicles/${first.id}`);
  await expect
    .poll(() => page.locator('[data-testid="vehicle-viewer"]').first().getAttribute('data-asset'), {
      timeout: 30000,
    })
    .toBe('glb');

  await page.goto('/presentation');
  await expect
    .poll(() => page.locator('[data-testid="vehicle-viewer"]').first().getAttribute('data-asset'), {
      timeout: 30000,
    })
    .toBe('glb');

  expect(
    consoleErrors.filter((t) => t.includes('404')),
    'no 404 console errors on /vehicles/<id> or /presentation (R2-61)',
  ).toEqual([]);
});

test('R2-15: a charging demo vehicle renders on /showroom and /vehicles/<id> with zero page errors', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = `e2e-glb15-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  // The demo fleet always seeds one 'charger' role vehicle whose state is
  // charging — the exact path that pulsed every emissive material once per
  // frame before the fix.
  const vehiclesRes = await page.request.get('/api/v1/vehicles');
  const vehicles =
    (
      (await vehiclesRes.json()) as {
        data?: { id: string; displayName?: string; state?: { chargingState?: string } }[];
      }
    ).data ?? [];
  const charging = vehicles.find((v) => v.state?.chargingState === 'charging');
  expect(charging, 'the demo fleet seeds a charging vehicle').toBeTruthy();

  await page.goto('/showroom');
  await page
    .getByRole('button', { name: new RegExp(charging!.displayName ?? '') })
    .first()
    .click();
  await expect
    .poll(() => page.locator('[data-testid="vehicle-viewer"]').first().getAttribute('data-asset'), {
      timeout: 30000,
    })
    .toBe('glb');

  await page.goto(`/vehicles/${charging!.id}`);
  await expect
    .poll(() => page.locator('[data-testid="vehicle-viewer"]').first().getAttribute('data-asset'), {
      timeout: 30000,
    })
    .toBe('glb');

  expect(errors, 'no page errors while rendering the charging vehicle').toEqual([]);
});

test('R2-43: the first orbit hands the camera to the user', async ({ page }) => {
  test.setTimeout(180_000);
  const email = `e2e-glb43-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  const vehiclesRes = await page.request.get('/api/v1/vehicles');
  const vehicles = ((await vehiclesRes.json()) as { data?: { id: string }[] }).data ?? [];
  await page.goto(`/vehicles/${vehicles[0]!.id}`);
  const viewer = page.locator('[data-testid="vehicle-viewer"]');
  await expect
    .poll(() => viewer.first().getAttribute('data-asset'), { timeout: 30000 })
    .toBe('glb');
  await expect(viewer.first()).toHaveAttribute('data-user-interacted', 'false');

  // Drag the viewer: the controls' onStart must flip the rig off.
  const canvas = viewer.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 40, { steps: 8 });
  await page.mouse.up();

  await expect(viewer.first()).toHaveAttribute('data-user-interacted', 'true', {
    timeout: 10000,
  });
});
