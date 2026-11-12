import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import {
  seuofficeWebAliases,
  seuofficeWebPlugins,
  seuofficeWebWorker,
} from '@seuoffice/web-platform/vite'
import { defineConfig, type Plugin } from 'vite'

// The Slides app for the browser: the renderer from src/renderer behind the web slidesApi in src/web.
// The deck is opened in the page with the engine and layout code the desktop main process runs.
// Same package-source mapping as the renderer block of electron.vite.config.ts (specific entries first).
const pkg = (path: string): string => resolve(__dirname, '../../packages', path)
const workspaceAlias: Record<string, string> = {
  '@seuoffice/pptx-engine/table-grid': pkg('pptx-engine/src/table-grid.ts'),
  '@seuoffice/pptx-engine/identity': pkg('pptx-engine/src/identity.ts'),
  '@seuoffice/pptx-engine/named-action': pkg('pptx-engine/src/named-action.ts'),
  '@seuoffice/pptx-engine/custgeom': pkg('pptx-engine/src/custgeom.ts'),
  '@seuoffice/pptx-engine/background-promote': pkg('pptx-engine/src/background-promote.ts'),
  '@seuoffice/pptx-engine/model3d': pkg('pptx-engine/src/model3d.ts'),
  '@seuoffice/pptx-engine/chart-workbook': pkg('pptx-engine/src/chart-workbook.ts'),
  '@seuoffice/pptx-engine': pkg('pptx-engine/src/index.ts'),
  '@seuoffice/pptx-ops/op-docs': pkg('pptx-ops/src/op-docs.ts'),
  '@seuoffice/pptx-ops/font-size': pkg('pptx-ops/src/font-size.ts'),
  '@seuoffice/pptx-ops': pkg('pptx-ops/src/index.ts'),
  '@seuoffice/pptx-render/preset-geometry': pkg('pptx-render/src/preset-geometry.ts'),
  '@seuoffice/pptx-render': pkg('pptx-render/src/index.ts'),
  '@seuoffice/pipelines/slides/layout-audit': pkg('pipelines/src/slides/layout-audit.ts'),
  '@seuoffice/pipelines/slides/templates': pkg('pipelines/src/slides/templates/index.ts'),
  '@seuoffice/pipelines/slides': pkg('pipelines/src/slides/index.ts'),
  '@seuoffice/docx-engine/metafile': pkg('docx-engine/src/metafile.ts'),
  '@seuoffice/docx-engine/math': pkg('docx-engine/src/math.ts'),
  '@seuoffice/docx-engine/init': pkg('docx-engine/src/engine-init.ts'),
  '@seuoffice/docx-engine/engine-url': pkg('docx-engine/src/engine-url.ts'),
}

/**
 * The deck's fonts are read through the main-process font code (main/fonts.ts), which reads
 * font files with synchronous fs calls: node:fs is an in-memory store here, and the directory
 * scan worker has nothing to scan, so a scan answers "nothing found".
 */
const webFontPlatform = {
  fs: resolve(__dirname, 'src/web/memfs.ts'),
  scan: resolve(__dirname, 'src/web/font-scan.ts'),
  pngjs: resolve(__dirname, '../../node_modules/pngjs/browser.js'),
}

function fontScanStub(): Plugin {
  return {
    name: 'seuoffice:slides-font-scan',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './font-scan' || !importer?.endsWith('/apps/slides/src/main/fonts.ts'))
        return null
      return webFontPlatform.scan
    },
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  plugins: [react(), fontScanStub(), ...seuofficeWebPlugins()],
  resolve: {
    alias: [
      ...Object.entries(workspaceAlias).map(([find, replacement]) => ({ find, replacement })),
      { find: /^(node:)?fs$/, replacement: webFontPlatform.fs },
      // the package's node entry pulls util/stream; the browser bundle ships next to it
      { find: /^pngjs$/, replacement: webFontPlatform.pngjs },
      ...seuofficeWebAliases(),
    ],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    // main/session-state.ts builds its runtime paths from __dirname when it loads; nothing reads them here
    __dirname: JSON.stringify('/web'),
  },
  build: {
    outDir: resolve(__dirname, '../web/dist/slides'),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: seuofficeWebWorker(),
})
