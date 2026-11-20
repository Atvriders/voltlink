// Visual regression: key pages snapshotted on desktop. Mobile and tablet
// snapshots live in visual-mobile.spec.ts under their real projects.
//
// R2-35 / C-VISUAL fixes applied here:
//  - full-page tolerance is maxDiffPixels: 25 (a pixel budget, not the old
//    0.04 ratio that let unrelated pages pass); the 3D viewer element shot
//    keeps maxDiffPixelRatio 0.01 for WebGL variance;
//  - every snapshot is preceded by content assertions on the page's own data
//    (the demo seed's five vehicles, rate names, automation names, drives,
//    notifications, status components — the same values the baselines show);
//  - dynamic regions (account chip, tabular numbers such as relative times
//    and odometers) are masked;
//  - the admin page is snapshotted as the instance admin; a non-admin must
//    see a 403 card and no administration nav (expected red until the step-5
//    product fix);
//  - baselines regenerate in R6, reviewed by eye (ROUND2_PLAN §R6).
//
// Snapshots live next to this file; regenerate only in R6 with
// --update-snapshots and review every diff image.

import { expect, test, type Page } from '@playwright/test';
import { DEMO_VEHICLES, enableDemo, register } from './helpers';

const T = { maxDiffPixels: 25 };

// Dynamic regions: the account chip (email) and tabular numbers (relative
// times, odometers, live counters) are masked in every logged-in snapshot.
function maskDynamic(page: Page) {
  return [page.getByRole('button', { name: 'Account menu' }), page.locator('.tabular-nums')];
}

async function loginAsInstanceAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.E2E_ADMIN_EMAIL ?? 'admin@voltlink-e2e.test');
  await page
    .getByLabel('Password')
    .fill(process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({
    timeout: 20000,
  });
}

async function assertDemoFleetOn(page: Page): Promise<void> {
  for (const name of DEMO_VEHICLES) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible({
      timeout: 30000,
    });
  }
}

// Register a fresh user, enable the demo fleet and assert every promised
// vehicle is rendered. This is the content gate that a 0-vehicle user can
// never pass (the C-VISUAL / VIS-01 failure mode).
async function registerWithDemoFleet(page: Page): Promise<void> {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/');
  await assertDemoFleetOn(page);
}

test('sign-in page', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'VoltLink' })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('signin.png', T);
});

test('overview desktop with demo fleet', async ({ page }) => {
  await registerWithDemoFleet(page);
  await assertDemoFleetOn(page);
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('overview.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('live vehicle controls panel', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.getByRole('button', { name: 'Live vehicle' }).first().click();
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  // The panel renders the real command buttons, never an empty shell.
  await expect(page.getByRole('button', { name: 'Honk horn', exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('live-vehicle.png', {
    ...T,
    mask: maskDynamic(page),
    timeout: 60000,
  });
});

test('drives page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/drives');
  await expect(page.getByRole('heading', { name: 'Drives' })).toBeVisible({
    timeout: 20000,
  });
  // Content: the seeded history renders drive rows with distances; the empty
  // state must not be what we snapshot.
  await expect(page.getByText('No drives found')).toHaveCount(0);
  await expect(page.getByText(/km/).first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('drives.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('charging page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/charging');
  await expect(page.getByText('Electricity rates')).toBeVisible({ timeout: 20000 });
  // Content: the seeded rate rules are listed.
  await expect(page.getByText('Home TOU', { exact: true }).first()).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('charging.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('automations page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/automations');
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible({ timeout: 20000 });
  // Content: the seeded automation is listed.
  await expect(page.getByText('Charge-complete notification', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('automations.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('fleet page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/fleet');
  await expect(page.getByText('Fleet status')).toBeVisible({ timeout: 20000 });
  // Content: the seeded counts, then the vehicle rows themselves.
  await expect(page.getByText('5 vehicles · 1 charging · 1 offline')).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole('cell', { name: /Aurora/ }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /Bison/ }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('fleet.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('public status page', async ({ page }) => {
  await page.goto('/status');
  await expect(page.getByText(/operational|degraded|outage|maintenance/i).first()).toBeVisible({
    timeout: 20000,
  });
  // Content: the component list renders (never an empty banner).
  await expect(page.getByRole('listitem').first()).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('public-status.png', T);
});

test('settings security tab', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await page.goto('/settings/security');
  await expect(page.getByText('Two-factor authentication (TOTP)', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(1200);
  await expect(page).toHaveScreenshot('settings-security.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('admin page as instance admin', async ({ page }) => {
  await loginAsInstanceAdmin(page);
  await page.goto('/admin');
  await expect(page.getByText('Users & roles')).toBeVisible({ timeout: 20000 });
  // Content: the real user list renders (the seeded instance admin's own row),
  // never the empty '0 accounts' page.
  await expect(page.getByText('E2E Instance Admin', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.waitForTimeout(1200);
  await expect(page).toHaveScreenshot('admin.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('admin page for a non-admin shows the 403 card and hides the nav', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await page.goto('/admin');
  // R2-35: a non-admin gets a 403 card (expected red until the step-5
  // product fix) and the administration nav is hidden.
  await expect(page.getByText(/access denied|forbidden|403/i).first()).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole('link', { name: /administration/i })).toHaveCount(0);
  await page.waitForTimeout(1200);
  await expect(page).toHaveScreenshot('admin-403.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('map page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/map');
  await expect(page.locator('div[aria-label="Map"]')).toBeVisible({
    timeout: 25000,
  });
  // Content: the mirrored map facts list the demo vehicles and places — the
  // blank-panel baseline is gone.
  const layers = page.locator('aside[aria-label="Map layers"]');
  await expect(layers.getByText('Vehicles', { exact: true })).toBeVisible({
    timeout: 25000,
  });
  await expect(layers.getByText('Places', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(layers.getByRole('button', { name: 'Show on map: Aurora' })).toBeVisible({
    timeout: 20000,
  });
  await expect(layers.getByRole('button', { name: 'Show on map: Home' })).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(3000);
  await expect(page).toHaveScreenshot('map.png', {
    maxDiffPixels: 25,
    mask: maskDynamic(page),
    timeout: 60000,
  });
});

test('light theme overview', async ({ page }) => {
  await registerWithDemoFleet(page);
  await assertDemoFleetOn(page);
  // switch to light theme via the theme menu
  await page.locator('[aria-label="Theme"]').click();
  await page.getByRole('menuitem', { name: /Light/i }).click();
  await page.waitForTimeout(1200);
  await expect(page).toHaveScreenshot('overview-light.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('battery page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/battery');
  await expect(page.getByText('Battery health estimate')).toBeVisible({
    timeout: 30000,
  });
  // Content: the health estimate renders its kWh figure.
  await expect(page.getByText(/kWh/).first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot('battery.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('notifications page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible({
    timeout: 30000,
  });
  // Content: the seeded welcome notification is listed.
  await expect(page.getByText('Your demo fleet is ready')).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('notifications.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('providers page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/providers');
  // Strict: the exact-count badge — the loose /demo vehicles/ regex also
  // matched the marketing sentence (strict-mode violation under workers=3).
  await expect(page.getByText(/^\d+ demo vehicles$/)).toBeVisible({
    timeout: 30000,
  });
  // Content: the demo provider's self-checks render.
  await expect(page.getByText('Fictional data')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('providers.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('vehicles list page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/vehicles');
  await assertDemoFleetOn(page);
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('vehicles.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('drive detail page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/drives');
  await expect(page.getByRole('heading', { name: 'Drives' })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('link').first().click();
  await expect(page.getByText(/km/).first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('drive-detail.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('showroom page', async ({ page }) => {
  await registerWithDemoFleet(page);
  await page.goto('/showroom');
  const viewer = page.locator('[data-testid="vehicle-viewer"]');
  await expect(viewer).toBeVisible({ timeout: 30000 });
  // Content: the viewer announces the loaded part names (data-parts hook).
  await expect(viewer).toHaveAttribute('data-parts', /body_mesh/, {
    timeout: 30000,
  });
  const parts = (await viewer.getAttribute('data-parts')) ?? '';
  expect(parts).toContain('body_mesh');
  await page.waitForTimeout(1500);
  // Viewer element shot keeps a ratio for WebGL variance; the page itself
  // still uses the 25-pixel budget.
  await expect(viewer).toHaveScreenshot('showroom-viewer.png', {
    maxDiffPixelRatio: 0.01,
    timeout: 60000,
  });
  await expect(page).toHaveScreenshot('showroom.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('admin users tab as instance admin', async ({ page }) => {
  await loginAsInstanceAdmin(page);
  await page.goto('/admin');
  await expect(page.getByText(/accounts|users/i).first()).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText(/0 accounts/)).toHaveCount(0);
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('admin-users.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('status admin page', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/status-admin');
  await expect(page.getByText(/component|operational/i).first()).toBeVisible({ timeout: 30000 });
  // Content: the seeded component is listed.
  await expect(page.getByText('Automation engine')).toBeVisible({
    timeout: 20000,
  });
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('status-admin.png', {
    ...T,
    mask: maskDynamic(page),
  });
});

test('onboarding welcome', async ({ page }) => {
  await register(page, `e2e-vis-${Date.now()}@voltlink.test`);
  await page.goto('/onboarding');
  await expect(page.getByText('Welcome to VoltLink')).toBeVisible({
    timeout: 30000,
  });
  await page.waitForTimeout(1000);
  await expect(page).toHaveScreenshot('onboarding.png', {
    ...T,
    mask: maskDynamic(page),
  });
});
