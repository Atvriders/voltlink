// Shared E2E helpers: register a fresh user and enable demo mode.

import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { demoFleetPredicate } from './demo-fleet-predicate';

/** Open registration answers 202 "check_email"; in the e2e environment the
 * dev token echo lands in the API log, so verify + sign in programmatically. */
async function devVerificationToken(email: string): Promise<string> {
  // R2-24: in production mode DEV_ECHO_TOKENS is refused, so read the real
  // verification email from the e2e SMTP sink's HTTP API. Dev fallback keeps
  // the old log-echo path.
  const smtpHttp = process.env.VL_E2E_SMTP_HTTP;
  if (smtpHttp) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${smtpHttp}/last?to=${encodeURIComponent(email)}`);
        if (res.ok) {
          const body = (await res.json()) as { textDecoded: string; text: string };
          const text = body.textDecoded ?? body.text;
          const m = text.match(/token=([A-Za-z0-9_-]+)/);
          if (m) return m[1]!;
        }
      } catch {
        /* sink not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`no verification email for ${email} at ${smtpHttp}`);
  }
  const log = fs.readFileSync('/tmp/voltlink-api.log', 'utf8');
  const matches = [...log.matchAll(/\[mail:dev\] token echoed \(dev only\): (\S+)/g)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error('no dev verification token in /tmp/voltlink-api.log');
  return last[1]!;
}

export async function register(page: Page, email: string): Promise<void> {
  const hydrated = page.waitForResponse((r) => r.url().includes('/api/v1/auth/me'));
  await page.goto('/register', { waitUntil: 'domcontentloaded' });
  // React mounts and AuthProvider issues /auth/me — only then are handlers attached.
  await hydrated;
  await page.getByLabel('Name').fill('E2E Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-123');
  const postDone = page.waitForResponse(
    (r) => r.url().includes('/auth/register') && r.request().method() === 'POST',
  );
  const meOk = page.waitForResponse((r) => r.url().includes('/api/v1/auth/me') && r.ok());
  await page.getByRole('button', { name: 'Create account' }).click();
  const regRes = await postDone;
  if (regRes.status() === 202) {
    // check_email: verify with the dev token, then sign in to get a session.
    const csrfRes = await page.request.get('/api/v1/auth/csrf');
    const csrf = ((await csrfRes.json()) as { data: { token: string } }).data.token;
    const token = await devVerificationToken(email);
    await page.request.post('/api/v1/auth/verify-email', {
      data: { token },
      headers: { 'x-vl-csrf': csrf },
    });
    const loginRes = await page.request.post('/api/v1/auth/login', {
      data: { email, password: 'e2e-password-123' },
      headers: { 'x-vl-csrf': csrf },
    });
    if (!loginRes.ok()) throw new Error(`login after verify failed: ${loginRes.status()}`);
  } else {
    await meOk;
  }
  // Ensure the session cookie is committed before the test navigates on.
  await expect
    .poll(async () => (await page.context().cookies()).some((c) => c.name === 'vl_session'), {
      timeout: 10000,
    })
    .toBe(true);
}

export async function enableDemo(page: Page): Promise<void> {
  await page.goto('/providers');
  await page.waitForURL(/providers/);
  const demoBtn = page.getByRole('button', { name: /Enable demo mode|Refresh demo fleet/ }).first();
  // The button appears once the accounts query resolves. Demo mode is a hard
  // requirement of every downstream assertion: fail if it never shows up.
  await demoBtn.waitFor({ state: 'visible', timeout: 15000 });
  // R2-16 / C-E2EHOLLOW: wait for the CONNECT RESPONSE, never static page
  // text ('All demo vehicles are fictional…' was satisfying the old wait with
  // zero vehicles on the server).
  const connectDone = page.waitForResponse(
    (r) => r.url().includes('/providers/demo/connect') && r.request().method() === 'POST',
    { timeout: 30000 },
  );
  await demoBtn.click();
  const connectRes = await connectDone;
  if (!connectRes.ok()) throw new Error(`demo connect failed: ${connectRes.status()}`);
  // R2-16 / C-E2EHOLLOW (review #2 point 11): the connect response carries
  // accountId; the fleet is valid only when the user has exactly ONE ACTIVE
  // PERSONAL OWNER membership and exactly five demo vehicles belonging to
  // that organization AND that account, each with a non-null state.
  const connectBody = (await connectRes.json()) as { data?: { accountId?: string } };
  const accountId = connectBody.data?.accountId;
  if (!accountId) throw new Error('demo connect response had no accountId');
  // Exact-count badge (strict match) — the marketing sentence never matches.
  await expect(page.getByText(/^\d+ demo vehicles$/)).toBeVisible({ timeout: 30000 });
  await expect
    .poll(
      async () => {
        const meRes = await page.request.get('/api/v1/auth/me');
        const vehRes = await page.request.get('/api/v1/vehicles');
        if (!meRes.ok() || !vehRes.ok()) return false;
        const meBody = (await meRes.json()) as {
          data?: { memberships?: { organizationId: string; kind: string; role: string }[] };
        };
        const vehBody = (await vehRes.json()) as {
          data?: {
            organizationId?: string;
            providerAccountId?: string;
            demo?: boolean;
            state?: unknown;
          }[];
        };
        return demoFleetPredicate({
          accountId,
          memberships: meBody.data?.memberships ?? [],
          vehicles: vehBody.data ?? [],
        });
      },
      { timeout: 30000 },
    )
    .toBe(true);
}

// The five demo vehicles the enableDemo predicate promises (demo.ts seed).
export const DEMO_VEHICLES = ['Aurora', 'Comet', 'Terra', 'Atlas', 'Bison'];
