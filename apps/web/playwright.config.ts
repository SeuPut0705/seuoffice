import { defineConfig, devices } from '@playwright/test'

/** Opens every supported format through the built launcher (run `npm run build` first). */
export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  outputDir: './test-results',
  globalSetup: './tests/global-setup.ts',
  timeout: 60_000,
  workers: 1,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: { baseURL: 'http://localhost:5300/', viewport: { width: 1400, height: 900 } },
  webServer: {
    command: 'npm run preview',
    port: 5300,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
