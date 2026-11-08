import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The launcher page; the suite apps are built into dist/<app>/ by scripts/build.mjs
export default defineConfig({
  root: __dirname,
  base: './',
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
