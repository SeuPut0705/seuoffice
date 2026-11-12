import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // every test process runs with a throwaway home folder, never the real one
    // and the wasm engine behind @seuoffice/pptx-engine started
    setupFiles: ['../../tools/test-home.ts', '../../packages/engine-wasm/src/node.ts'],
    testTimeout: 20000,
  },
})
