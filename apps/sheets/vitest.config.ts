import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // @seuoffice/collab ships TypeScript source under this export condition
  ssr: { resolve: { conditions: ['seuoffice-source', ...defaultServerConditions] } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
