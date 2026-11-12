import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../../packages/docx-engine/', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-equality.ts', '../../tools/docx-diff/model-capture.setup.ts'],
    testTimeout: 20000,
    maxWorkers: 2,
  },
})