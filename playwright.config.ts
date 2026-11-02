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
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /no-webgl\.spec\.ts|tesla\.spec\.ts|a11y\.spec\.ts/,
    },
    // Gate 7: every page is exercised at desktop, tablet and mobile sizes.
    // Visual snapshots are desktop-only (viewport coverage lives in the
    // acceptance spec, which asserts layout on Pixel 7 and iPad profiles).
    {
      name: 'tablet',
      use: { ...devices['iPad Pro 11'], defaultBrowserType: 'chromium', browserName: 'chromium' },
      testIgnore: /visual\.spec\.ts|no-webgl\.spec\.ts|tesla\.spec\.ts|a11y\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testIgnore: /visual\.spec\.ts|no-webgl\.spec\.ts|tesla\.spec\.ts|a11y\.spec\.ts/,
    },
    // Tesla spec runs only through scripts/e2e/tesla-e2e.sh (fake Fleet
    // API + seeded user); the device projects above ignore it.
    { name: 'tesla', use: { ...devices['Desktop Chrome'] }, testMatch: /tesla\.spec\.ts/ },
    // Accessibility scan (guide 08 §12): axe on every core page, desktop only.
    { name: 'a11y', use: { ...devices['Desktop Chrome'] }, testMatch: /a11y\.spec\.ts/ },
    // Guide 06 §12: WebGL rendering is exercised both on real GL and on the
    // SwiftShader software path, and WebGL-disabled browsers degrade instead
    // of crashing (G-14).
    {
      name: 'webgl-swiftshader',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--use-gl=swiftshader', '--disable-gpu'] },
      },
      testMatch: /webgl-assets\.spec\.ts/,
    },
    {
      name: 'no-webgl',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--disable-webgl', '--disable-gpu'] },
      },
      testMatch: /no-webgl\.spec\.ts/,
    },
  ],
});
