import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3111',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1360, height: 900 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Gate 7: every page is exercised at desktop, tablet and mobile sizes.
    // Visual snapshots are desktop-only (viewport coverage lives in the
    // acceptance spec, which asserts layout on Pixel 7 and iPad profiles).
    {
      name: 'tablet',
      use: { ...devices['iPad Pro 11'], defaultBrowserType: 'chromium', browserName: 'chromium' },
      testIgnore: /visual\.spec\.ts/,
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: /visual\.spec\.ts/ },
  ],
});
