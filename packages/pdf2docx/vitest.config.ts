import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // resolve the sibling source package by path (not via node_modules), so a
      // git worktree whose node_modules is linked to another checkout still
      // tests against the local docx-engine edits
      '@seuoffice/docx-engine': fileURLToPath(
        new URL('../docx-engine/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // the engine behind @seuoffice/docx-engine starts here: the alias skips the package's `node` entry
    setupFiles: [fileURLToPath(new URL('../engine-wasm/src/node.ts', import.meta.url))],
    testTimeout: 20000,
  },
})
