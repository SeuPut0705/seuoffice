import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // @seuoffice/* workspace packages ship TS source (no build step, no
    // compiled entry point) — externalizing them makes Node's ESM loader try
    // to resolve their relative imports at runtime and fail. Bundle those;
    // externalize everything else (Electron, zod, node builtins).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@seuoffice/ai-provider',
          '@seuoffice/agent-core',
          '@seuoffice/ai-search',
          '@seuoffice/docx-engine',
          '@seuoffice/file-parse',
          '@seuoffice/font-metrics',
          '@seuoffice/electron-utils',
          '@seuoffice/i18n',
          '@seuoffice/pptx-render',
          '@seuoffice/ui',
          '@seuoffice/xlsx-gateway',
        ],
      }),
    ],
  },
  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at
    // runtime, so the drop-open bridge and the subscription channel names
    // (@seuoffice/ai-provider/browser, which reaches @seuoffice/i18n for the
    // product name) must be bundled, not externalized.
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@seuoffice/electron-utils', '@seuoffice/ai-provider', '@seuoffice/i18n'],
      }),
    ],
  },
  renderer: {
    plugins: [react()],
  },
})
