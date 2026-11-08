import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { seuofficeWebAliases, seuofficeWebPlugins } from '@seuoffice/web-platform/vite'
import { defineConfig, type Plugin } from 'vite'

// The renderer entry imports './template-fonts' for desktop-only font files; the web build swaps in a no-op.
const webTemplateFonts = (): Plugin => ({
  name: 'seuoffice-web-template-fonts',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './template-fonts' && importer?.endsWith('/src/renderer/main.tsx')) {
      return resolve(__dirname, 'src/web/template-fonts.web.ts')
    }
    return null
  },
})

// The Sheets app for the browser: the renderer from src/renderer behind the web desktopApi in src/web.
// The xlsx engine runs as src/web/generated/xlsx-wasm.wasm, built by native/xlsx-wasm/build.mjs.
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  plugins: [react(), webTemplateFonts(), ...seuofficeWebPlugins()],
  resolve: { alias: seuofficeWebAliases() },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve(__dirname, '../web/dist/sheets'),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: { format: 'es' },
})
