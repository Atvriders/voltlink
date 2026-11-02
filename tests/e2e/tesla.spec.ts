// Tesla e2e (guide 01 §14): connect through the fake OAuth, import, see the
// virtual-key readiness state, pair in the fake, and watch the check flip.
// Run via scripts/e2e/tesla-e2e.sh, which starts the fake and sets the env.

import { test, expect } from '@playwright/test';

const FAKE = process.env.E2E_TESLA_FAKE_URL;

test.describe('Tesla connect + virtual key (fake Fleet API)', () => {
  test.skip(!process.env.E2E_TESLA_FAKE_URL, 'Tesla e2e runs via scripts/e2e/tesla-e2e.sh only');

  test('connect, import, pair, readiness flips', async ({ page }) => {
    // The stack was seeded by scripts/e2e/tesla-e2e.sh with a login-ready user.
    await page.goto('/login');
    await page
      .getByLabel('Email')
      .fill(process.env.E2E_USER_EMAIL ?? 'tesla-e2e-user@voltlink.test');
    await page.getByLabel('Password').fill(process.env.E2E_USER_PASSWORD ?? 'e2e-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect
      .poll(async () => (await page.context().cookies()).some((c) => c.name === 'vl_session'), {
        timeout: 10000,
      })
      .toBe(true);

    // Connect: the fake authorize endpoint 302s straight back with a code.
    await page.goto('/providers');
    const authorize = page.getByRole('button', { name: /Connect with Tesla/i });
    await expect(authorize).toBeVisible({ timeout: 15000 });
    // The authorize GET 302s to the fake, which 302s back to the callback,
    // which 302s home with connected=tesla. Wait for the final URL.
    await authorize.click();
    await page.waitForURL(/providers\?connected=tesla/, { timeout: 30000 });

    // Import vehicles for the connected account (wait for the row to render).
    const importBtn = page.getByRole('button', { name: 'Import', exact: true }).first();
    await expect(importBtn).toBeVisible({ timeout: 15000 });
    const imported = page.waitForResponse(
      (r) => r.url().includes('/import') && r.request().method() === 'POST' && r.ok(),
      { timeout: 30000 },
    );
    await importBtn.click();
    await imported;

    // Readiness shows the virtual key is missing (protocol required, unpaired).
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/v1/providers/readiness');
          const body = (await res.json()) as {
            data: {
              provider: string;
              ok: boolean;
              checks: { name: string; ok: boolean; detail: string }[];
            }[];
          };
          const tesla = body.data.find((r) => r.provider === 'tesla');
          const key = tesla?.checks.find((c) => c.name.includes('.key'));
          return key?.detail ?? '';
        },
        { timeout: 15000 },
      )
      .toContain('virtual key not paired');

    // Pair the key in the fake, then the check flips to ok.
    const readiness = await page.request.get('/api/v1/providers/readiness');
    const rd = (await readiness.json()) as {
      data: { accountId?: string; checks: { name: string }[] }[];
    };
    const vinCheck = rd.data
      .find((r) => r.provider === 'tesla')
      ?.checks.find((c) => c.name.includes('.key'));
    expect(vinCheck).toBeDefined();
    const vinLast4 = vinCheck!.name.split('.')[1]!;
    // The fake always uses 5YJ3000000NEXUS01; pair it directly.
    await page.request.post(`${FAKE}/__control/pair`, { data: { vin: '5YJ3000000NEXUS01' } });
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/v1/providers/readiness');
          const body = (await res.json()) as {
            data: { checks: { name: string; ok: boolean; detail: string }[] }[];
          };
          const key = body.data
            .find((r) => (r as { provider?: string }).provider === 'tesla')
            ?.checks.find((c) => c.name.includes(`.${vinLast4}.key`));
          return key?.ok ?? false;
        },
        { timeout: 15000 },
      )
      .toBe(true);
  });
});
