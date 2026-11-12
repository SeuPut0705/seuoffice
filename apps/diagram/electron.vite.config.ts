import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const bundled = ['@seuoffice/i18n', '@seuoffice/electron-utils', '@seuoffice/drawio-model']

export default defineConfig({
  // workspace packages ship as TS source and must be bundled
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
  },
  renderer: {
    plugins: [react()],
    server: {
      port: Number(process.env.DIAGRAM_DEV_PORT) || 5182,
      strictPort: Boolean(process.env.DIAGRAM_DEV_PORT),
    },
  },
})
