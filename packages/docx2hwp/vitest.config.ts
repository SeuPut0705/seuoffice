import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// resolve sibling source packages by path (not via node_modules), so a git
// worktree whose node_modules is linked to another checkout still tests
// against this checkout's edits
const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@seuoffice/docx-engine': local('../docx-engine/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // the engine behind @seuoffice/docx-engine starts here: the alias skips the package's `node` entry
    setupFiles: [fileURLToPath(new URL('../engine-wasm/src/node.ts', import.meta.url))],
    testTimeout: 30000,
  },
})
