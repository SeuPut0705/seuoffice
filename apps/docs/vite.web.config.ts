import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import {
  seuofficeWebAliases,
  seuofficeWebPlugins,
  seuofficeWebWorker,
} from '@seuoffice/web-platform/vite'
import { defineConfig } from 'vite'

// The Docs app for the browser: the renderer from src/renderer behind the web desktop bridge in src/web.
// Same package-source mapping as the renderer block of electron.vite.config.ts (specific entries first).
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
  // SEUOFFICE_DOCX_ENGINE=ts: the TypeScript engine frozen at the switch
  // (tools/docx-diff/reference), for the render benchmark of the wasm binding
  // against it (.github/workflows/seuoffice-bench.yml); never a release build
  '@seuoffice/docx-engine':
    process.env.SEUOFFICE_DOCX_ENGINE === 'ts'
      ? resolve(__dirname, '../../tools/docx-diff/reference/index.ts')
      : resolve(__dirname, '../../packages/docx-engine/src/index.ts'),
  '@seuoffice/odt-engine': resolve(__dirname, '../../packages/odt-engine/src/index.ts'),
}

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  plugins: [react(), ...seuofficeWebPlugins()],
  resolve: {
    alias: [
      ...Object.entries(localAlias).map(([find, replacement]) => ({ find, replacement })),
      ...seuofficeWebAliases(),
    ],
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve(__dirname, '../web/dist/docs'),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: seuofficeWebWorker(),
})
