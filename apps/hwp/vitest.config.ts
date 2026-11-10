import { defaultClientConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // seuoffice: the web bridge imports @seuoffice/web-platform, whose co-editing page reads
  // @seuoffice/collab, which ships TypeScript source under this export condition
  resolve: { conditions: ['seuoffice-source', ...defaultClientConditions] },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
})
