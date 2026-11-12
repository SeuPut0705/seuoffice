import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // @seuoffice/collab ships TypeScript source under this export condition
  ssr: { resolve: { conditions: ['seuoffice-source', ...defaultServerConditions] } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // the engine behind @seuoffice/file-parse starts here, before the mains' engine-init reads its ?asset path
    setupFiles: ['../../packages/engine-wasm/src/node.ts'],
  },
})
