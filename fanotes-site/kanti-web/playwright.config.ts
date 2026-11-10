import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT || 4783)
// Locally the system chromium is used (no browser download); CI uses Playwright's own.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
    trace: 'retain-on-failure',
    launchOptions: { executablePath },
  },
  webServer: {
    command: 'node e2e/server.mjs',
    url: `http://127.0.0.1:${port}/api/v1/kanti-web/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { E2E_PORT: String(port) },
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
  ],
})
