import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // every case renders in a real Chromium; each opens its own page and temp
    // dir on the file's shared browser, so cases run side by side instead of
    // waiting on one another's page loads
    sequence: { concurrent: true },
    maxConcurrency: 8,
    testTimeout: 90000,
    hookTimeout: 60000,
  },
})
