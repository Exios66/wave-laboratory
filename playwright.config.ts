import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
/** Software WebGL so tests run on GPU-less CI machines. */
const SWIFTSHADER = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: /mobile\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: { args: SWIFTSHADER },
      },
    },
    {
      name: 'android-chromium',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Pixel 7'], launchOptions: { args: SWIFTSHADER } },
    },
    {
      // iPhone viewport, touch and user agent on Chromium (always available).
      name: 'iphone-viewport',
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices['iPhone 14'],
        browserName: 'chromium',
        defaultBrowserType: 'chromium',
        launchOptions: { args: SWIFTSHADER },
      },
    },
    // Real WebKit (Safari's engine) when installed: `pnpm exec playwright install webkit`
    // then run with PW_WEBKIT=1.
    ...(process.env.PW_WEBKIT
      ? [
          {
            name: 'iphone-webkit',
            testMatch: /mobile\.spec\.ts/,
            use: { ...devices['iPhone 14'] },
          },
          {
            name: 'desktop-webkit',
            testMatch: /app\.spec\.ts/,
            use: { ...devices['Desktop Safari'] },
          },
        ]
      : []),
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
