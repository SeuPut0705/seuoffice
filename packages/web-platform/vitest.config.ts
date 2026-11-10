import { defaultClientConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // the co-editing engine and server from their source, as the web builds read them
  resolve: { conditions: ['seuoffice-source', ...defaultClientConditions] },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
  },
})
