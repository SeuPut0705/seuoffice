import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // @seuoffice/i18n and @seuoffice/electron-utils ship as TS source — must be bundled
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@seuoffice/i18n', '@seuoffice/electron-utils', '@seuoffice/odt-engine'],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@seuoffice/i18n', '@seuoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react()],
    server: {
      port: Number(process.env.HTML_DEV_PORT) || 5178,
      strictPort: Boolean(process.env.HTML_DEV_PORT),
    },
  },
})
