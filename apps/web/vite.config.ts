import { resolve } from 'node:path'
import { defaultClientConditions, defineConfig } from 'vite'

// The launcher page; the suite apps are built into dist/<app>/ by scripts/build.mjs
export default defineConfig({
  root: __dirname,
  base: './',
  // workspace builds read @seuoffice/embed from its source; the published package ships dist
  resolve: { conditions: ['seuoffice-source', ...defaultClientConditions] },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    target: 'es2022',
  },
  preview: {
    port: 5300,
    strictPort: true,
  },
})
