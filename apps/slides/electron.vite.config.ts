import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const here = dirname(fileURLToPath(import.meta.url))

// Pin resolution to this repo's workspace sources (matches tsconfig paths;
// avoids bundling stale implementations when node_modules links point elsewhere)
const workspaceAlias = {
  // Subpath before the bare name: string aliases are prefix replacements
  '@seuoffice/pptx-engine/table-grid': resolve(
    here,
    '../../packages/pptx-engine/src/table-grid.ts',
  ),
  '@seuoffice/pptx-engine/identity': resolve(here, '../../packages/pptx-engine/src/identity.ts'),
  '@seuoffice/pptx-engine/named-action': resolve(
    here,
    '../../packages/pptx-engine/src/named-action.ts',
  ),
  '@seuoffice/pptx-engine/custgeom': resolve(here, '../../packages/pptx-engine/src/custgeom.ts'),
  '@seuoffice/pptx-engine/background-promote': resolve(
    here,
    '../../packages/pptx-engine/src/background-promote.ts',
  ),
  '@seuoffice/pptx-engine/model3d': resolve(here, '../../packages/pptx-engine/src/model3d.ts'),
  '@seuoffice/pptx-engine/chart-workbook': resolve(
    here,
    '../../packages/pptx-engine/src/chart-workbook.ts',
  ),
  '@seuoffice/pptx-engine/init': resolve(here, '../../packages/pptx-engine/src/engine-init.ts'),
  '@seuoffice/pptx-engine/engine-url': resolve(
    here,
    '../../packages/pptx-engine/src/engine-url.ts',
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
  // Metafile (EMF/WMF) rasterizer shared with the docs engine (renderer-only: needs canvas)
  '@seuoffice/docx-engine/metafile': resolve(here, '../../packages/docx-engine/src/metafile.ts'),
  '@seuoffice/docx-engine/math': resolve(here, '../../packages/docx-engine/src/math.ts'),
  '@seuoffice/docx-engine/init': resolve(here, '../../packages/docx-engine/src/engine-init.ts'),
  '@seuoffice/docx-engine/engine-url': resolve(
    here,
    '../../packages/docx-engine/src/engine-url.ts',
  ),
}

export default defineConfig({
  // Main process/preload must bundle @seuoffice/* sources (they are pulled in as TS
  // source with extensionless relative imports; externalizing them under Node
  // yields ERR_MODULE_NOT_FOUND).
  main: {
    resolve: { alias: workspaceAlias },
    // Bundle opentype.js too (the packaged app ships only out/**, so external deps are unresolvable at runtime)
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@seuoffice/agent-core',
          '@seuoffice/pptx-engine',
          '@seuoffice/pptx-ops',
          '@seuoffice/pptx-render',
          '@seuoffice/pipelines',
          '@seuoffice/ai-search',
          '@seuoffice/file-parse',
          '@seuoffice/xlsx-gateway',
          '@seuoffice/electron-utils',
          'opentype.js',
        ],
      }),
    ],
  },
  preload: {
    // electron-utils ships raw TS source — must be bundled, not left external
    plugins: [externalizeDepsPlugin({ exclude: ['@seuoffice/electron-utils'] })],
  },
  renderer: {
    resolve: { alias: workspaceAlias },
    plugins: [react()],
    server: {
      port: Number(process.env.SLIDES_DEV_PORT) || 5175,
      strictPort: Boolean(process.env.SLIDES_DEV_PORT),
    },
  },
})
