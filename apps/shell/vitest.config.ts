import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: [
      // the engine behind @seuoffice/file-parse starts here, before the mains' engine-init reads its ?asset path
      '../../packages/engine-wasm/src/node.ts',
      // every test process runs with a throwaway home folder, never the real one
      '../../tools/test-home.ts',
    ],
    testTimeout: 20000,
  },
})
