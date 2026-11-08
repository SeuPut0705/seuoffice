import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import {
  seuofficeWebAliases,
  seuofficeWebPlugins,
  seuofficeWebWorker,
} from '@seuoffice/web-platform/vite'
import { defineConfig, normalizePath, type Plugin } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// The PDF app for the browser: the renderer from src/renderer behind the web pdfApi in src/web
const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(dirname(require.resolve('pdfjs-dist/package.json')))
const pdfjsDir = (sub: string) => normalizePath(join(pdfjsRoot, 'pdfjs-dist', sub))

/** src/main save stages that need desktop engines; the web save runs without them */
const DESKTOP_STAGES = new Set(
  ['atomic-write', 'redaction', 'text-edit', 'image-edit', 'annot-delete', 'annot-flatten'].map(
    (stem) => normalizePath(resolve(__dirname, `src/main/${stem}.ts`)),
  ),
)

function desktopStages(): Plugin {
  const stand = resolve(__dirname, 'src/web/desktop-stages.ts')
  return {
    name: 'seuoffice:pdf-desktop-stages',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith('./')) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      return resolved && DESKTOP_STAGES.has(normalizePath(resolved.id)) ? stand : null
    },
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  plugins: [
    react(),
    desktopStages(),
    viteStaticCopy({
      targets: [
        { src: pdfjsDir('cmaps'), dest: 'pdfjs' },
        { src: pdfjsDir('standard_fonts'), dest: 'pdfjs' },
        { src: pdfjsDir('wasm'), dest: 'pdfjs' },
      ],
    }),
    ...seuofficeWebPlugins(),
  ],
  resolve: { alias: seuofficeWebAliases() },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve(__dirname, '../web/dist/pdf'),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: seuofficeWebWorker(),
})
