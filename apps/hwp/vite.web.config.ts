import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import {
  seuofficeWebAliases,
  seuofficeWebPlugins,
  seuofficeWebWorker,
} from '@seuoffice/web-platform/vite'
import { defineConfig } from 'vite'
import { rhwpPatches } from './scripts/rhwp-patches.mjs'

// The HWP app for the browser: the renderer from src/renderer behind the web hwpApi in src/web.
// public/ holds the prebuilt rhwp-studio (scripts/build-studio.mjs); it lands in dist/hwp/studio.
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), rhwpPatches('sdk-scheme'), ...seuofficeWebPlugins()],
  resolve: { alias: seuofficeWebAliases() },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve(__dirname, '../web/dist/hwp'),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: seuofficeWebWorker(),
})
