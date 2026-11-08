import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { rhwpPatches } from './scripts/rhwp-patches.mjs'

export default defineConfig({
  // @genoffice/i18n and @genoffice/electron-utils ship as TS source — must be bundled
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/i18n', '@genoffice/electron-utils'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/i18n', '@genoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react(), rhwpPatches('sdk-scheme')],
    // holds the rhwp-studio build (scripts/build-studio.mjs)
    publicDir: resolve(__dirname, 'public'),
    server: {
      port: Number(process.env.HWP_DEV_PORT) || 5179,
      strictPort: Boolean(process.env.HWP_DEV_PORT),
    },
  },
})
