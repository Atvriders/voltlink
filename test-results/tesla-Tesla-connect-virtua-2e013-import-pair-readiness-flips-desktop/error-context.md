# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tesla.spec.ts >> Tesla connect + virtual key (fake Fleet API) >> connect, import, pair, readiness flips
- Location: tests/e2e/tesla.spec.ts:10:7

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false

Call Log:
- Timeout 10000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - img "VoltLink" [ref=e6]
      - heading "VoltLink" [level=1] [ref=e7]
      - paragraph [ref=e8]: Sign in to your connected-vehicle platform
    - generic [ref=e9]:
      - alert [ref=e10]: Invalid email or password.
      - generic [ref=e11]:
        - generic [ref=e12]: Email
        - textbox "Email" [ref=e13]: tesla-e2e-user@voltlink.test
      - generic [ref=e14]:
        - generic [ref=e15]: Password
        - textbox "Password" [ref=e16]: e2e-password-123
      - button "Sign in" [ref=e17]
      - button "Sign in with passkey" [ref=e21]
      - generic [ref=e25]:
        - link "Forgot password?" [ref=e26] [cursor=pointer]:
          - /url: /forgot-password
        - link "Create account" [ref=e27] [cursor=pointer]:
          - /url: /register
    - paragraph [ref=e28]:
      - text: Self-hosted and privacy-first.
      - link "System status" [ref=e29] [cursor=pointer]:
        - /url: /status
  - status [ref=e30]
  - alert [ref=e31]
```

# Test source

```ts
  1  | // Tesla e2e (guide 01 §14): connect through the fake OAuth, import, see the
  2  | // virtual-key readiness state, pair in the fake, and watch the check flip.
  3  | // Run via scripts/e2e/tesla-e2e.sh, which starts the fake and sets the env.
  4  | 
  5  | import { test, expect } from '@playwright/test';
  6  | 
  7  | const FAKE = process.env.E2E_TESLA_FAKE_URL;
  8  | 
  9  | test.describe('Tesla connect + virtual key (fake Fleet API)', () => {
  10 |   test('connect, import, pair, readiness flips', async ({ page }) => {
  11 |     // The stack was seeded by scripts/e2e/tesla-e2e.sh with a login-ready user.
  12 |     await page.goto('/login');
  13 |     await page
  14 |       .getByLabel('Email')
  15 |       .fill(process.env.E2E_USER_EMAIL ?? 'tesla-e2e-user@voltlink.test');
  16 |     await page.getByLabel('Password').fill(process.env.E2E_USER_PASSWORD ?? 'e2e-password-123');
  17 |     await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  18 |     await expect
  19 |       .poll(async () => (await page.context().cookies()).some((c) => c.name === 'vl_session'), {
  20 |         timeout: 10000,
  21 |       })
> 22 |       .toBe(true);
     |        ^ Error: expect(received).toBe(expected) // Object.is equality
  23 | 
  24 |     // Connect: the fake authorize endpoint 302s straight back with a code.
  25 |     await page.goto('/providers');
  26 |     const authorize = page.getByRole('button', { name: /Connect with Tesla/i });
  27 |     await expect(authorize).toBeVisible({ timeout: 15000 });
  28 |     // The authorize GET 302s to the fake, which 302s back to the callback,
  29 |     // which 302s home with connected=tesla. Wait for the final URL.
  30 |     await authorize.click();
  31 |     await page.waitForURL(/providers\?connected=tesla/, { timeout: 30000 });
  32 | 
  33 |     // Import vehicles for the connected account (wait for the row to render).
  34 |     const importBtn = page.getByRole('button', { name: 'Import', exact: true }).first();
  35 |     await expect(importBtn).toBeVisible({ timeout: 15000 });
  36 |     const imported = page.waitForResponse(
  37 |       (r) => r.url().includes('/import') && r.request().method() === 'POST' && r.ok(),
  38 |       { timeout: 30000 },
  39 |     );
  40 |     await importBtn.click();
  41 |     await imported;
  42 | 
  43 |     // Readiness shows the virtual key is missing (protocol required, unpaired).
  44 |     await expect
  45 |       .poll(
  46 |         async () => {
  47 |           const res = await page.request.get('/api/v1/providers/readiness');
  48 |           const body = (await res.json()) as {
  49 |             data: {
  50 |               provider: string;
  51 |               ok: boolean;
  52 |               checks: { name: string; ok: boolean; detail: string }[];
  53 |             }[];
  54 |           };
  55 |           const tesla = body.data.find((r) => r.provider === 'tesla');
  56 |           const key = tesla?.checks.find((c) => c.name.includes('.key'));
  57 |           return key?.detail ?? '';
  58 |         },
  59 |         { timeout: 15000 },
  60 |       )
  61 |       .toContain('virtual key not paired');
  62 | 
  63 |     // Pair the key in the fake, then the check flips to ok.
  64 |     const readiness = await page.request.get('/api/v1/providers/readiness');
  65 |     const rd = (await readiness.json()) as {
  66 |       data: { accountId?: string; checks: { name: string }[] }[];
  67 |     };
  68 |     const vinCheck = rd.data
  69 |       .find((r) => r.provider === 'tesla')
  70 |       ?.checks.find((c) => c.name.includes('.key'));
  71 |     expect(vinCheck).toBeDefined();
  72 |     const vinLast4 = vinCheck!.name.split('.')[1]!;
  73 |     // The fake always uses 5YJ3000000NEXUS01; pair it directly.
  74 |     await page.request.post(`${FAKE}/__control/pair`, { data: { vin: '5YJ3000000NEXUS01' } });
  75 |     await expect
  76 |       .poll(
  77 |         async () => {
  78 |           const res = await page.request.get('/api/v1/providers/readiness');
  79 |           const body = (await res.json()) as {
  80 |             data: { checks: { name: string; ok: boolean; detail: string }[] }[];
  81 |           };
  82 |           const key = body.data
  83 |             .find((r) => (r as { provider?: string }).provider === 'tesla')
  84 |             ?.checks.find((c) => c.name.includes(`.${vinLast4}.key`));
  85 |           return key?.ok ?? false;
  86 |         },
  87 |         { timeout: 15000 },
  88 |       )
  89 |       .toBe(true);
  90 |   });
  91 | });
  92 | 
```