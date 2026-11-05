// R2-17 (round 2): the command lifecycle must reach a terminal state on the
// server, and the UI must reflect it. The pre-fix acceptance test accepted any
// static status label, so it passed even with the worker stopped. This test
// polls the API and demands a terminal status: with the worker stopped it must
// fail.

import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

const TERMINAL = ['accepted', 'not_observable', 'rejected', 'failed', 'timed_out'];

test('R2-17: honk reaches a terminal lifecycle state (API + UI)', async ({ page }) => {
  test.setTimeout(240_000);
  const email = `e2e-lc-${Date.now()}@voltlink.test`;
  await register(page, email);
  await enableDemo(page);

  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 90000 });
  await page.getByRole('button', { name: 'Live vehicle' }).first().click();
  await expect(page).toHaveURL(/\/vehicles\/[^/]+$/, { timeout: 20000 });
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });

  const vehicleId = page.url().match(/\/vehicles\/([^/]+)/)?.[1];
  expect(vehicleId, 'vehicle id from the URL').toBeTruthy();

  await page.getByRole('button', { name: /^Honk horn/ }).click();

  // API side: the command must leave the queue. With the worker stopped this
  // never happens and the test fails after the deadline.
  const deadline = Date.now() + 90_000;
  let statuses: string[] = [];
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/v1/commands?vehicleId=${vehicleId}`);
    expect(res.status(), 'command list must be reachable').toBe(200);
    const body = await res.json();
    statuses = (body?.data?.items ?? []).map((c: { status?: string }) => c.status ?? '');
    if (statuses.some((s) => TERMINAL.includes(s))) break;
    await page.waitForTimeout(500);
  }
  expect(
    statuses.join(','),
    'command must reach a terminal state (accepted|not_observable|rejected|failed|timed_out)',
  ).toMatch(new RegExp(TERMINAL.join('|')));

  // UI side: the lifecycle modal must eventually show the terminal state too.
  await expect(
    page
      .locator('[data-testid="lifecycle-modal"], [role="dialog"]')
      .getByText(new RegExp(TERMINAL.join('|')))
      .first(),
    { timeout: 15000 },
  ).toBeVisible();
});
