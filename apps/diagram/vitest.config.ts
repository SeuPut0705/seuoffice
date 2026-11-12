import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // the engine behind @seuoffice/file-parse starts here, before the mains' engine-init reads its ?asset path
    setupFiles: ['../../packages/engine-wasm/src/node.ts'],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
