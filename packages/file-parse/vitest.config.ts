import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // the tests import src/ directly, past the package's `node` entry that starts the engine
    setupFiles: [fileURLToPath(new URL('../engine-wasm/src/node.ts', import.meta.url))],
    testTimeout: 20000,
  },
})
