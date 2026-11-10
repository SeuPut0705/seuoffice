import { defineConfig, devices } from '@playwright/test'

// SEUOFFICE_WEB_PORT lets several checkouts run this suite on one machine at once
const port = Number(process.env.SEUOFFICE_WEB_PORT ?? 5300)

/** Opens every supported format through the built launcher (run `npm run build` first). */
export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  outputDir: './test-results',
  globalSetup: './tests/global-setup.ts',
  timeout: 60_000,
  workers: 1,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: { baseURL: `http://localhost:${port}/`, viewport: { width: 1400, height: 900 } },
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    // the co-editing specs' server rides on the preview (tests/collab-server.ts)
    env: { SEUOFFICE_COLLAB_SERVER: '1' },
    port,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
