import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import {
  ENGINE_NODE_SETUP,
  engineWasmAsset,
  engineWasmEnv,
} from '../../packages/engine-wasm/src/vitest'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // the engine behind @seuoffice/docx-engine: the mains start it from a ?asset path
  plugins: [engineWasmAsset()],
  // Pin resolution to this repo's workspace sources (matches tsconfig paths)
  resolve: {
    alias: {
      // Subpath before the bare name: string aliases are prefix replacements
      '@seuoffice/pptx-engine/table-grid': resolve(
        here,
        '../../packages/pptx-engine/src/table-grid.ts',
      ),
      '@seuoffice/pptx-engine/identity': resolve(
        here,
        '../../packages/pptx-engine/src/identity.ts',
      ),
      '@seuoffice/pptx-engine/named-action': resolve(
        here,
        '../../packages/pptx-engine/src/named-action.ts',
      ),
      '@seuoffice/pptx-engine/background-promote': resolve(
        here,
        '../../packages/pptx-engine/src/background-promote.ts',
      ),
      '@seuoffice/pptx-engine/custgeom': resolve(
        here,
        '../../packages/pptx-engine/src/custgeom.ts',
      ),
      '@seuoffice/pptx-engine/model3d': resolve(here, '../../packages/pptx-engine/src/model3d.ts'),
      '@seuoffice/pptx-engine/chart-workbook': resolve(
        here,
        '../../packages/pptx-engine/src/chart-workbook.ts',
      ),
      '@seuoffice/pptx-engine': resolve(here, '../../packages/pptx-engine/src/index.ts'),
      '@seuoffice/pptx-ops/op-docs': resolve(here, '../../packages/pptx-ops/src/op-docs.ts'),
      '@seuoffice/pptx-ops/font-size': resolve(here, '../../packages/pptx-ops/src/font-size.ts'),
      '@seuoffice/pptx-ops': resolve(here, '../../packages/pptx-ops/src/index.ts'),
      '@seuoffice/pptx-render/preset-geometry': resolve(
        here,
        '../../packages/pptx-render/src/preset-geometry.ts',
      ),
      '@seuoffice/pptx-render': resolve(here, '../../packages/pptx-render/src/index.ts'),
      '@seuoffice/pipelines/slides/layout-audit': resolve(
        here,
        '../../packages/pipelines/src/slides/layout-audit.ts',
      ),
      '@seuoffice/pipelines/slides/templates': resolve(
        here,
        '../../packages/pipelines/src/slides/templates/index.ts',
      ),
      '@seuoffice/pipelines/slides': resolve(here, '../../packages/pipelines/src/slides/index.ts'),
      '@seuoffice/docx-engine/metafile': resolve(
        here,
        '../../packages/docx-engine/src/metafile.ts',
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    // jsdom resolves packages without the `node` condition: the engine behind @seuoffice/docx-engine starts here
    env: engineWasmEnv(),
    setupFiles: [ENGINE_NODE_SETUP],
    testTimeout: 20000,
  },
})
