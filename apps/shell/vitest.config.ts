import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // every test process runs with a throwaway home folder, never the real one
    // the engine behind @seuoffice/file-parse starts here, before the mains' engine-init reads its ?asset path
    setupFiles: ['../../packages/engine-wasm/src/node.ts', '../../tools/test-home.ts'],
    testTimeout: 20000,
  },
})
