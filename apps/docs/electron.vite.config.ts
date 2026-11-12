import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Resolve workspace packages from this checkout's sources: in a git worktree
// node_modules is a symlink into the main checkout, so bare specifiers would
// silently bundle the other checkout's (possibly stale) code.
const localAlias = {
  '@seuoffice/docx-engine/lazy-media': resolve(
    __dirname,
    '../../packages/docx-engine/src/lazy-media.ts',
  ),
  '@seuoffice/docx-engine/zip-splice': resolve(
    __dirname,
    '../../packages/docx-engine/src/zip-splice.ts',
  ),
  '@seuoffice/docx-engine/init': resolve(
    __dirname,
    '../../packages/docx-engine/src/engine-init.ts',
  ),
  '@seuoffice/docx-engine/engine-url': resolve(
    __dirname,
    '../../packages/docx-engine/src/engine-url.ts',
  ),
  '@seuoffice/docx-engine': resolve(__dirname, '../../packages/docx-engine/src/index.ts'),
  '@seuoffice/odt-engine': resolve(__dirname, '../../packages/odt-engine/src/index.ts'),
  '@seuoffice/docx2hwp': resolve(__dirname, '../../packages/docx2hwp/src/index.ts'),
}

export default defineConfig({
  // Main and preload use only electron + node builtins; bundle everything so
  // the packaged app doesn't rely on node_modules at runtime.
  // @seuoffice/* deps ship as raw TS source with extensionless imports, so they
  // must be bundled — externalizing them yields ERR_MODULE_NOT_FOUND under Node
  // (same setup as apps/slides).
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          // TS source whose modules import each other without extensions
          '@seuoffice/agent-core',
          '@seuoffice/docx-engine',
          // the Hangul export's converter, run in its worker thread
          '@seuoffice/docx2hwp',
          '@seuoffice/electron-utils',
          '@seuoffice/font-metrics',
          '@seuoffice/odt-engine',
          // the template font list the media scheme serves from
          '@seuoffice/ui',
          // the mail merge's CSV and workbook readers
          '@seuoffice/xlsx-gateway',
        ],
      }),
    ],
    resolve: { alias: localAlias },
  },
  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at
    // runtime, so the drop-open bridge must be bundled, not externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['@seuoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: localAlias },
    server: {
      // Overridable so multiple seuoffice dev instances can coexist (default 5173).
      port: Number(process.env.DOCS_DEV_PORT) || 5173,
      strictPort: Boolean(process.env.DOCS_DEV_PORT),
    },
  },
})
