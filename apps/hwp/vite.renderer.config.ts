import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { rhwpPatches } from './scripts/rhwp-patches.mjs'

// renderer-only dev server (embedded by shell via HWP_RENDERER_URL for HMR; no standalone Electron)
export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), rhwpPatches('sdk-scheme')],
  // holds the rhwp-studio build (scripts/build-studio.mjs)
  publicDir: resolve(__dirname, 'public'),
  server: {
    port: Number(process.env.HWP_DEV_PORT) || 5179,
    strictPort: true,
  },
})
