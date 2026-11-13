import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const slashed = (path: string): string => path.replaceAll('\\', '/')
const SRC = slashed(fileURLToPath(new URL('../../packages/docx-engine/src/', import.meta.url)))
const REFERENCE = slashed(fileURLToPath(new URL('./reference/', import.meta.url)))

/**
 * The tests of packages/docx-engine import `../src/...`, which since the switch is the binding over
 * the wasm engine. The capture records what the TypeScript engine produced: everything that
 * resolves into packages/docx-engine/src is served from the frozen copy in reference/ instead.
 */
const reference: Plugin = {
  name: 'docx-engine-reference',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    const id = resolved === null ? '' : slashed(resolved.id)
    if (resolved === null || !id.startsWith(SRC)) return null
    return { ...resolved, id: REFERENCE + id.slice(SRC.length) }
  },
}

export default defineConfig({
  root: fileURLToPath(new URL('../../packages/docx-engine/', import.meta.url)),
  plugins: [reference],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-equality.ts', '../../tools/docx-diff/model-capture.setup.ts'],
    testTimeout: 20000,
    maxWorkers: 2,
  },
})
