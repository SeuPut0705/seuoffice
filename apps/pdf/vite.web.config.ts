import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { seuofficeWebAliases, seuofficeWebPlugins } from '@seuoffice/web-platform/vite'
import { defineConfig, normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// The PDF app for the browser: the renderer from src/renderer behind the web pdfApi in src/web
const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(dirname(require.resolve('pdfjs-dist/package.json')))
const pdfjsDir = (sub: string) => normalizePath(join(pdfjsRoot, 'pdfjs-dist', sub))

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  plugins: [
    react(),
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
  worker: { format: 'es' },
})
