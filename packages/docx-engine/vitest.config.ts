import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // the tests import the sources by path, not through the `node` export condition
    setupFiles: ['../engine-wasm/src/node.ts', 'tests/setup-equality.ts'],
    testTimeout: 20000,
  },
})
