// Browser tests run against a stack that is already up: the backend (serving
// the front end), the ML service and a seeded MySQL. They do not start it.
//
//   E2E_BASE_URL   default http://localhost:4000
//   E2E_WRITE=1    also run the tests that create an account (use a
//                  disposable database: CI does; your dev database would keep it)
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
