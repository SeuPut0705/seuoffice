import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    // jsdom resolves packages without the `node` condition: the engine behind @seuoffice/docx-engine starts here
    setupFiles: ['../../packages/engine-wasm/src/node.ts'],
    testTimeout: 20000,
  },
})
