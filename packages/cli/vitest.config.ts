import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // every test process runs with a throwaway home folder, never the real one
    setupFiles: ['../../tools/test-home.ts'],
    testTimeout: 60000,
  },
})
