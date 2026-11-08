import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import {
  seuofficeWebAliases,
  seuofficeWebPlugins,
  seuofficeWebWorker,
} from '@seuoffice/web-platform/vite'
import { defineConfig } from 'vite'

// The Sheets app for the browser: the renderer from src/renderer behind the web desktopApi in src/web.
// The xlsx engine runs as src/web/generated/xlsx-wasm.wasm, built by native/xlsx-wasm/build.mjs.
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  plugins: [react(), ...seuofficeWebPlugins()],
  resolve: { alias: seuofficeWebAliases() },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve(__dirname, '../web/dist/sheets'),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: seuofficeWebWorker(),
})
