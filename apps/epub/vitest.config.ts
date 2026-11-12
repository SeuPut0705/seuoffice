import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'jsdom',
    // the engine behind @seuoffice/file-parse starts here, before the mains' engine-init reads its ?asset path
    setupFiles: ['../../packages/engine-wasm/src/node.ts', 'tests/setup.ts'],
    testTimeout: 20000,
  },
})
