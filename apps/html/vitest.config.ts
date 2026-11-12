import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    // jsdom resolves packages without the `node` condition: the engine behind @genoffice/docx-engine starts here
    setupFiles: ['../../packages/docx-engine/src/engine-node.ts'],
    testTimeout: 20000,
  },
})
