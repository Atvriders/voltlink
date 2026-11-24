// R2-17 / C-E2ENOWORKER / TI-05 (guide 08 §10): the @lifecycle spec.
// Demands, per issued command id:
//   - API: terminal status + the queued -> submitted -> accepted/rejected event
//     sequence (honk must reach accepted|not_observable, never just 'queued');
//   - UI: the lifecycle modal reflects the SAME command id and a terminal
//     data-status (never the static step label).
// Rejected case: Comet remote_start is refused by the demo provider.
import { expect, test, type Page } from '@playwright/test';
import { enableDemo, register } from './helpers';

const TERMINAL = ['confirmed', 'accepted', 'not_observable', 'rejected', 'failed', 'timed_out'];

type Cmd = {
  id: string;
  status?: string;
  confirmation?: string;
  createdAt?: string;
  events?: { event: string }[];
};

async function newestCommand(page: Page, vehicleId: string, afterMs: number): Promise<Cmd> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/v1/commands?vehicleId=${vehicleId}&pageSize=100`);
    expect(res.status(), 'command list must be reachable').toBe(200);
    const body = (await res.json()) as { data?: { items?: Cmd[] } };
    const items = (body.data?.items ?? []).filter(
      (c) => new Date(c.createdAt ?? 0).getTime() >= afterMs,
    );
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
    const events = detail.events ?? cmd.events ?? [];
    // R2-18 (review 1b): the worker writes the status and the audit event in
    // two writes — poll until BOTH the status is terminal AND the terminal
    // event exists, so the caller never reads the chain mid-write.
    if (cmd.status && TERMINAL.includes(cmd.status) && events.some((e) => e.event === cmd.status)) {
      return { ...cmd, events };
    }
    await page.waitForTimeout(500);
  }
  throw new Error('command did not reach a terminal state within 90s');
}

/** Poll until a SPECIFIC status (and its audit event) — 'accepted' alone is
 * not enough for an observable command whose confirm lands ~10 s later. */
async function waitForStatus(page: Page, commandId: string, status: string): Promise<Cmd> {
  const deadline = Date.now() + 90_000;
  let last: Cmd = { id: commandId };
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/v1/commands/${commandId}`);
    expect(res.status(), 'command detail must be reachable').toBe(200);
    const body = (await res.json()) as {
      data?: { command?: Cmd; events?: { event: string }[] } & Cmd;
    };
    const detail = (body.data ?? {}) as { command?: Cmd; events?: { event: string }[] };
    const cmd = (detail.command ?? detail) as Cmd;
    const events = detail.events ?? cmd.events ?? [];
    last = { ...cmd, events };
    if (cmd.status === status && events.some((e) => e.event === status)) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(`command did not reach ${status} within 90s (last: ${last.status})`);
}

test('@lifecycle R2-17: honk reaches accepted/not_observable with the full event chain (API + UI)', async ({
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

  const clickTime = Date.now();
  await page.getByRole('button', { name: /^Honk horn/ }).click();

  // The ISSUED command's id (not just any vehicle command).
  const issued = await newestCommand(page, vehicleId!, clickTime);
  expect(issued.id).toBeTruthy();

  // API: terminal + event chain queued -> submitted -> accepted.
  const final = await waitTerminal(page, issued.id);
  // commands-12: honk is not_observable — the spec is accepted AND the
  // confirmation field is not_observable, never the other way round.
  expect(final.status, 'honk terminal status').toBe('accepted');
  expect(final.confirmation, 'honk confirmation').toBe('not_observable');
  const events = (final.events ?? []).map((e) => e.event);
  const chain = ['queued', 'submitted'];
  for (const step of chain) {
    expect(events, `event chain must contain ${step}`).toContain(step);
  }
  expect(events, 'event chain must contain accepted').toContain('accepted');
  const q = events.indexOf('queued');
  const s = events.indexOf('submitted');
  const a = events.indexOf('accepted');
  expect(q, 'queued before submitted').toBeGreaterThanOrEqual(0);
  expect(s, 'submitted after queued').toBeGreaterThan(q);
  expect(a, 'accepted after submitted').toBeGreaterThan(s);

  // UI: the modal for THIS command shows a terminal data-status.
  await expect(
    page.locator(`[data-command-id="${issued.id}"][data-status]`).first(),
    'lifecycle modal with the issued command id',
  ).toBeVisible({ timeout: 15000 });
  // UI: the modal for THIS command shows accepted + not_observable.
  const modal = page.locator(`[data-command-id="${issued.id}"]`).first();
  await expect
    .poll(async () => (await modal.getAttribute('data-status')) ?? '', {
      timeout: 15000,
    })
    .toBe('accepted');
  await expect
    .poll(async () => (await modal.getAttribute('data-confirmation')) ?? '', {
      timeout: 15000,
    })
    .toBe('not_observable');
});

test('@lifecycle R2-17: rejected lifecycle — Bison open_trunk is refused end to end', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await register(page, `e2e-lc-rej-${Date.now()}@voltlink.test`);
  await enableDemo(page);

  const vres = await page.request.get('/api/v1/vehicles');
  const vbody = (await vres.json()) as {
    data?: { id: string; displayName?: string }[];
  };
  const bison = (vbody.data ?? []).find((v) => (v.displayName ?? '').includes('Bison'));
  expect(bison, 'Bison exists in the demo fleet').toBeTruthy();
  await page.goto(`/vehicles/${bison!.id}`);
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  const vehicleId = bison!.id;

  const clickTime = Date.now();
  await page.getByRole('button', { name: 'Open trunk', exact: true }).click();

  const issued = await newestCommand(page, vehicleId, clickTime);
  const final = await waitTerminal(page, issued.id);
  expect(final.status, 'offline Bison open_trunk must be rejected').toBe('rejected');
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

test('@lifecycle R2-17: timed_out lifecycle — Bison window_vent times out end to end', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await register(page, `e2e-lc-to-${Date.now()}@voltlink.test`);
  await enableDemo(page);

  const vres = await page.request.get('/api/v1/vehicles');
  const vbody = (await vres.json()) as {
    data?: { id: string; displayName?: string }[];
  };
  const bison = (vbody.data ?? []).find((v) => (v.displayName ?? '').includes('Bison'));
  expect(bison, 'Bison exists in the demo fleet').toBeTruthy();
  await page.goto(`/vehicles/${bison!.id}`);
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  const vehicleId = bison!.id;

  const clickTime = Date.now();
  await page.getByRole('button', { name: 'Vent windows', exact: true }).click();

  const issued = await newestCommand(page, vehicleId, clickTime);
  const final = await waitTerminal(page, issued.id);
  expect(final.status, 'Bison window_vent must reach timed_out').toBe('timed_out');
  await expect
    .poll(
      async () =>
        (await page
          .locator(`[data-command-id="${issued.id}"]`)
          .first()
          .getAttribute('data-status')) ?? '',
      { timeout: 15000 },
    )
    .toBe('timed_out');
});

test('@lifecycle R2-17: confirmed lifecycle — Aurora lock reaches confirmed with the full event chain', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await register(page, `e2e-lc-conf-${Date.now()}@voltlink.test`);
  await enableDemo(page);

  const vres = await page.request.get('/api/v1/vehicles');
  const vbody = (await vres.json()) as {
    data?: { id: string; displayName?: string }[];
  };
  const aurora = (vbody.data ?? []).find((v) => (v.displayName ?? '').includes('Aurora'));
  expect(aurora, 'Aurora exists in the demo fleet').toBeTruthy();
  await page.goto(`/vehicles/${aurora!.id}`);
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  const vehicleId = aurora!.id;

  // An OBSERVABLE command: the demo snapshot has locked=true, so lock
  // accepts, the confirm stage matches the ingested snapshot and the command
  // ends confirmed (guide 08 s10 / C-E2ENOWORKER).
  const clickTime = Date.now();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();

  const issued = await newestCommand(page, vehicleId, clickTime);
  const final = await waitForStatus(page, issued.id, 'confirmed');
  expect(final.status, 'Aurora lock must reach confirmed').toBe('confirmed');
  const events = (final.events ?? []).map((e) => e.event);
  for (const step of ['queued', 'submitted', 'accepted', 'confirmed']) {
    expect(events, `event chain must contain ${step}`).toContain(step);
  }
  const q = events.indexOf('queued');
  const s = events.indexOf('submitted');
  const a = events.indexOf('accepted');
  const c = events.indexOf('confirmed');
  expect(q).toBeGreaterThanOrEqual(0);
  expect(s).toBeGreaterThan(q);
  expect(a).toBeGreaterThan(s);
  expect(c, 'confirmed after accepted').toBeGreaterThan(a);

  // UI: the modal for THIS command shows data-status=confirmed.
  await expect
    .poll(
      async () =>
        (await page
          .locator(`[data-command-id="${issued.id}"]`)
          .first()
          .getAttribute('data-status')) ?? '',
      { timeout: 15000 },
    )
    .toBe('confirmed');
});
