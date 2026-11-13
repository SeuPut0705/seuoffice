import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // every test process runs with a throwaway home folder, never the real one
    // the tests that import the docx-engine sources by path start its engine here
    setupFiles: ['../../tools/test-home.ts', '../engine-wasm/src/node.ts'],
    testTimeout: 60000,
  },
})
