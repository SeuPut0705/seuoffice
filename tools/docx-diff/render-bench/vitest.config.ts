// The docs renderer's test setup, with @seuoffice/docx-engine pointed at the
// frozen TypeScript engine under BENCH_ENGINE=ts (render-bench.test.ts).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import docs from '../../../apps/docs/vitest.config'

const alias = { ...(docs.resolve!.alias as Record<string, string>) }
if (process.env.BENCH_ENGINE === 'ts')
  alias['@seuoffice/docx-engine'] = fileURLToPath(new URL('../reference/index.ts', import.meta.url))

export default defineConfig({
  resolve: { ...docs.resolve, alias },
  test: {
    ...docs.test,
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['render-bench.test.ts'],
    testTimeout: 600_000,
  },
})
