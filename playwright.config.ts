import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Specs are *.spec.ts; *.test.ts files in tests/e2e (vitest unit tests like
  // demo-fleet-predicate.test.ts) are never Playwright tests.
  testMatch: /\.spec\.ts$/,
  timeout: 60000,
  expect: {
    timeout: 10000,
    // web-10: the pixel contract lives in config defaults, not per-call flags.
    toHaveScreenshot: {
      maxDiffPixels: 25,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
      stylePath: ['tests/e2e/screenshot.css'],
    },
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // list for humans; json for scripts/test-inventory.ts (guide 08 §5).
  // Keep Playwright artifacts out of test-results/ root: vitest's JSON
  // report (vitest.json) and the inventory live there, and Playwright wipes
  // its outputDir on every run.
  outputDir: 'test-results/pw',
  reporter: [['list'], ['json', { outputFile: 'test-results/playwright.json' }]],
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
      testIgnore:
        /no-webgl\.spec\.ts|tesla\.spec\.ts|a11y\.spec\.ts|visual-mobile\.spec\.ts|visual-no-webgl\.spec\.ts|visual-reduced-motion\.spec\.ts/,
    },
    // Gate 7: every page is exercised at desktop, tablet and mobile sizes.
    // Desktop visual snapshots run in the desktop project; the mobile and
    // tablet snapshots run under their real device projects via
    // visual-mobile.spec.ts (C-VISUAL / FE-26: never a desktop render with a
    // fake viewport).
    {
      name: 'tablet',
      use: { ...devices['iPad Pro 11'], defaultBrowserType: 'chromium', browserName: 'chromium' },
      testIgnore:
        /visual\.spec\.ts|no-webgl\.spec\.ts|tesla\.spec\.ts|a11y\.spec\.ts|visual-no-webgl\.spec\.ts|visual-reduced-motion\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testIgnore:
        /visual\.spec\.ts|no-webgl\.spec\.ts|tesla\.spec\.ts|a11y\.spec\.ts|visual-no-webgl\.spec\.ts|visual-reduced-motion\.spec\.ts/,
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
      testIgnore: /visual-no-webgl\.spec\.ts/,
    },
    // Guide 08 §11 state #8: the WebGL fallback visual baseline.
    {
      name: 'visual-no-webgl',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--disable-webgl', '--disable-gpu'] },
      },
      testMatch: /visual-no-webgl\.spec\.ts/,
    },
    // Guide 08 §11 state #21: reduced-motion visual baseline.
    {
      name: 'visual-reduced-motion',
      use: {
        ...devices['Desktop Chrome'],
        contextOptions: { reducedMotion: 'reduce' },
      },
      testMatch: /visual-reduced-motion\.spec\.ts/,
    },
  ],
});
