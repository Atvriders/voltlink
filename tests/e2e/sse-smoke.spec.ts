// PL-02: SSE smoke — the realtime stream (guide 05 §7) delivers a command
// event to the signed-in user's EventSource in a real browser session.
// Keeps ci.yml's "the Playwright matrix covers … SSE" claim true.

import { expect, test } from '@playwright/test';
import { enableDemo, register } from './helpers';

declare global {
  interface Window {
    __voltlinkSseEvents?: Array<{ type?: string; data?: unknown }>;
  }
}

test('PL-02: /api/v1/realtime delivers a command event to the signed-in user', async ({ page }) => {
  await register(page, `e2e-sse-${Date.now()}@voltlink.test`);
  await enableDemo(page);
  await page.goto('/');
  await expect(page.getByText('Aurora', { exact: true }).first()).toBeVisible({
    timeout: 30000,
  });

  // Same-origin EventSource carries the session cookie. The hub sends named
  // events (`event: command`), so listen for the command type specifically.
  await page.evaluate(() => {
    window.__voltlinkSseEvents = [];
    const es = new EventSource('/api/v1/realtime');
    for (const name of ['command', 'heartbeat', 'resync']) {
      es.addEventListener(name, (m) => {
        try {
          window.__voltlinkSseEvents!.push({
            type: name,
            data: JSON.parse((m as MessageEvent<string>).data) as unknown,
          });
        } catch {
          // ignore non-JSON frames
        }
      });
    }
    es.onerror = () => {
      window.__voltlinkSseEvents!.push({ type: '__error' });
    };
  });

  await page.getByRole('button', { name: 'Live vehicle' }).first().click();
  await expect(page.getByText('Remote controls')).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Honk horn', exact: true }).click();

  // The API publishes the 'command' event at issue time (commands/service.ts
  // ssePublish) — the stream must deliver it to this session.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window.__voltlinkSseEvents ?? []).filter((e) => e.type === 'command').length,
        ),
      { timeout: 15000, message: 'a command event must reach the realtime stream' },
    )
    .toBeGreaterThan(0);
});
