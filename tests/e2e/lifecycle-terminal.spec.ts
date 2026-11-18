// R2-17 / C-E2ENOWORKER / TI-05 (guide 08 §10): the @lifecycle spec.
// Demands, per issued command id:
//   - API: terminal status + the queued -> submitted -> accepted/rejected event
//     sequence (honk must reach accepted|not_observable, never just 'queued');
//   - UI: the lifecycle modal reflects the SAME command id and a terminal
//     data-status (never the static step label).
// Rejected case: Comet remote_start is refused by the demo provider.
import { expect, test, type Page } from '@playwright/test';
import { enableDemo, register } from './helpers';

const TERMINAL = ['accepted', 'not_observable', 'rejected', 'failed', 'timed_out'];

type Cmd = { id: string; status?: string; createdAt?: string; events?: { event: string }[] };

async function newestCommand(page: Page, vehicleId: string): Promise<Cmd> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/v1/commands?vehicleId=${vehicleId}&pageSize=100`);
    expect(res.status(), 'command list must be reachable').toBe(200);
    const body = (await res.json()) as { data?: { items?: Cmd[] } };
    const items = body.data?.items ?? [];
    if (items.length > 0) {
      return items.reduce((a, b) =>
        new Date(b.createdAt ?? 0).getTime() > new Date(a.createdAt ?? 0).getTime() ? b : a,
      );
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no command appeared within 15s of clicking');
}

async function waitTerminal(page: Page, commandId: string): Promise<Cmd> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/v1/commands/${commandId}`);
    expect(res.status(), 'command detail must be reachable').toBe(200);
    const body = (await res.json()) as {
      data?: { command?: Cmd; events?: { event: string }[] } & Cmd;
    };
    const detail = (body.data ?? {}) as { command?: Cmd; events?: { event: string }[] };
    const cmd = (detail.command ?? detail) as Cmd;
    if (cmd.status && TERMINAL.includes(cmd.status)) {
      return { ...cmd, events: detail.events ?? cmd.events };
    }
    await page.waitForTimeout(500);
  }
  throw new Error('command did not reach a terminal state within 90s');
}

test('R2-17: honk reaches accepted/not_observable with the full event chain (API + UI)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await register(page, `e2e-lc-${Date.now()}@voltlink.test`);
  await enableDemo(page);

  await page.goto('/');
  await expect(page.getByText('Aurora').first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Live vehicle' }).first().click();
  await expect(page).toHaveURL(/\/vehicles\/[^/]+$/, { timeout: 20000 });
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });

  const vehicleId = page.url().match(/\/vehicles\/([^/]+)/)?.[1];
  expect(vehicleId, 'vehicle id from the URL').toBeTruthy();

  await page.getByRole('button', { name: /^Honk horn/ }).click();

  // The ISSUED command's id (not just any vehicle command).
  const issued = await newestCommand(page, vehicleId!);
  expect(issued.id).toBeTruthy();

  // API: terminal + event chain queued -> submitted -> accepted.
  const final = await waitTerminal(page, issued.id);
  expect(final.status, 'honk terminal status').toMatch(/^(accepted|not_observable)$/);
  const events = (final.events ?? []).map((e) => e.event);
  const chain = ['queued', 'submitted'];
  for (const step of chain) {
    expect(events, `event chain must contain ${step}`).toContain(step);
  }
  expect(events, 'event chain must contain accepted or not_observable').toContain(
    final.status ?? 'accepted',
  );
  const q = events.indexOf('queued');
  const s = events.indexOf('submitted');
  const a = events.indexOf(final.status ?? 'accepted');
  expect(q, 'queued before submitted').toBeGreaterThanOrEqual(0);
  expect(s, 'submitted after queued').toBeGreaterThan(q);
  expect(a, 'accepted after submitted').toBeGreaterThan(s);

  // UI: the modal for THIS command shows a terminal data-status.
  await expect(
    page.locator(`[data-command-id="${issued.id}"][data-status]`).first(),
    'lifecycle modal with the issued command id',
  ).toBeVisible({ timeout: 15000 });
  await expect
    .poll(
      async () =>
        (await page
          .locator(`[data-command-id="${issued.id}"]`)
          .first()
          .getAttribute('data-status')) ?? '',
      { timeout: 15000 },
    )
    .toMatch(/^(accepted|not_observable)$/);
});

test('R2-17: rejected lifecycle — Comet remote_start is refused end to end', async ({ page }) => {
  test.setTimeout(240_000);
  await register(page, `e2e-lc-rej-${Date.now()}@voltlink.test`);
  await enableDemo(page);

  const vres = await page.request.get('/api/v1/vehicles');
  const vbody = (await vres.json()) as {
    data?: { items?: { id: string; displayName?: string }[] };
  };
  const comet = (vbody.data?.items ?? []).find((v) => (v.displayName ?? '').includes('Comet'));
  expect(comet, 'Comet exists in the demo fleet').toBeTruthy();
  await page.goto(`/vehicles/${comet!.id}`);
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  const vehicleId = comet!.id;

  await page.getByRole('button', { name: /Remote start/ }).click();

  const issued = await newestCommand(page, vehicleId!);
  const final = await waitTerminal(page, issued.id);
  expect(final.status, 'Comet remote_start must be rejected').toBe('rejected');
  await expect
    .poll(
      async () =>
        (await page
          .locator(`[data-command-id="${issued.id}"]`)
          .first()
          .getAttribute('data-status')) ?? '',
      { timeout: 15000 },
    )
    .toBe('rejected');
});
