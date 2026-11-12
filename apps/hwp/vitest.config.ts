import { defaultClientConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // seuoffice: the web bridge imports @seuoffice/web-platform, whose co-editing page reads
  // @seuoffice/collab, which ships TypeScript source under this export condition
  resolve: { conditions: ['seuoffice-source', ...defaultClientConditions] },
  test: {
    include: ['tests/**/*.test.ts'],
    // the engine behind @seuoffice/file-parse starts here, before the mains' engine-init reads its ?asset path
    setupFiles: ['../../packages/engine-wasm/src/node.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
})
