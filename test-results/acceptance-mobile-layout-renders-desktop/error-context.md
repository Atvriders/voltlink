# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: acceptance.spec.ts >> mobile layout renders
- Location: tests/e2e/acceptance.spec.ts:74:5

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.waitForResponse: Test timeout of 60000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - img "VoltLink" [ref=e6]
      - heading "Create your VoltLink account" [level=1] [ref=e7]
    - generic [ref=e8]:
      - alert [ref=e9]: An invitation token is required to register on this instance.
      - generic [ref=e10]:
        - generic [ref=e11]: Name
        - textbox "Name" [ref=e12]: E2E Tester
      - generic [ref=e13]:
        - generic [ref=e14]: Email
        - textbox "Email" [ref=e15]: e2e-m-1793493947605@voltlink.test
      - generic [ref=e16]:
        - generic [ref=e17]: Password
        - textbox "Password" [ref=e18]: e2e-password-123
        - paragraph [ref=e19]: At least 10 characters.
      - button "Create account" [ref=e20]
      - paragraph [ref=e24]:
        - text: Already have an account?
        - link "Sign in" [ref=e25] [cursor=pointer]:
          - /url: /login
    - paragraph [ref=e26]: Your data stays on your server. VoltLink never sells or shares it.
  - status [ref=e27]
  - alert [ref=e28]
```

# Test source

```ts
  1  | // Shared E2E helpers: register a fresh user and enable demo mode.
  2  | 
  3  | import fs from 'node:fs';
  4  | import { expect, type Page } from '@playwright/test';
  5  | 
  6  | /** Open registration answers 202 "check_email"; in the e2e environment the
  7  |  * dev token echo lands in the API log, so verify + sign in programmatically. */
  8  | async function devVerificationToken(): Promise<string> {
  9  |   const log = fs.readFileSync('/tmp/voltlink-api.log', 'utf8');
  10 |   const matches = [...log.matchAll(/\[mail:dev\] token echoed \(dev only\): (\S+)/g)];
  11 |   const last = matches[matches.length - 1];
  12 |   if (!last) throw new Error('no dev verification token in /tmp/voltlink-api.log');
  13 |   return last[1]!;
  14 | }
  15 | 
  16 | export async function register(page: Page, email: string): Promise<void> {
  17 |   const hydrated = page.waitForResponse((r) => r.url().includes('/api/v1/auth/me'));
  18 |   await page.goto('/register', { waitUntil: 'domcontentloaded' });
  19 |   // React mounts and AuthProvider issues /auth/me — only then are handlers attached.
  20 |   await hydrated;
  21 |   await page.getByLabel('Name').fill('E2E Tester');
  22 |   await page.getByLabel('Email').fill(email);
  23 |   await page.getByLabel('Password').fill('e2e-password-123');
  24 |   const postDone = page.waitForResponse(
  25 |     (r) => r.url().includes('/auth/register') && r.request().method() === 'POST',
  26 |   );
> 27 |   const meOk = page.waitForResponse((r) => r.url().includes('/api/v1/auth/me') && r.ok());
     |                     ^ Error: page.waitForResponse: Test timeout of 60000ms exceeded.
  28 |   await page.getByRole('button', { name: 'Create account' }).click();
  29 |   const regRes = await postDone;
  30 |   if (regRes.status() === 202) {
  31 |     // check_email: verify with the dev token, then sign in to get a session.
  32 |     const csrfRes = await page.request.get('/api/v1/auth/csrf');
  33 |     const csrf = ((await csrfRes.json()) as { data: { token: string } }).data.token;
  34 |     const token = await devVerificationToken();
  35 |     await page.request.post('/api/v1/auth/verify-email', {
  36 |       data: { token },
  37 |       headers: { 'x-vl-csrf': csrf },
  38 |     });
  39 |     const loginRes = await page.request.post('/api/v1/auth/login', {
  40 |       data: { email, password: 'e2e-password-123' },
  41 |       headers: { 'x-vl-csrf': csrf },
  42 |     });
  43 |     if (!loginRes.ok()) throw new Error(`login after verify failed: ${loginRes.status()}`);
  44 |   } else {
  45 |     await meOk;
  46 |   }
  47 |   // Ensure the session cookie is committed before the test navigates on.
  48 |   await expect
  49 |     .poll(async () => (await page.context().cookies()).some((c) => c.name === 'vl_session'), {
  50 |       timeout: 10000,
  51 |     })
  52 |     .toBe(true);
  53 | }
  54 | 
  55 | export async function enableDemo(page: Page): Promise<void> {
  56 |   await page.goto('/providers');
  57 |   await page.waitForURL(/providers/);
  58 |   const demoBtn = page.getByRole('button', { name: /Enable demo mode|Refresh demo fleet/ }).first();
  59 |   // The button only appears once the accounts query resolves; give it a beat
  60 |   // instead of skipping demo mode when the page is still loading.
  61 |   await demoBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
  62 |   if (await demoBtn.count()) {
  63 |     await demoBtn.click();
  64 |     await expect(page.getByText(/demo vehicles/)).toBeVisible({ timeout: 30000 });
  65 |   }
  66 | }
  67 | 
```